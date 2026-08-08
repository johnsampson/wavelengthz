import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function makeUser(id: string) {
  await insertTestUser(env.DB, {
    id,
    spotifyId: `sp-${id}`,
    accessToken: 'a',
    refreshToken: 'r',
    tokenExpiresAt: 9999999999999,
    createdAt: 1000,
    updatedAt: 1000,
  });
}

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  // Child rows before parent `users` rows -- D1 enforces FK constraints here.
  // blocks, reports, matches, sessions, and people_swipes all reference users(id).
  await env.DB.exec('DELETE FROM blocks; DELETE FROM reports; DELETE FROM matches; DELETE FROM people_swipes; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM sessions; DELETE FROM users;');
  await makeUser('u1');
  await makeUser('u2');
});

describe('POST /api/block', () => {
  it('creates a block row and ends any active match', async () => {
    await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m1', 'u1', 'u2', 1000)`).run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/block', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u2' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const block = await env.DB.prepare('SELECT * FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind('u1', 'u2').first();
    expect(block).toBeTruthy();

    const match = await env.DB.prepare('SELECT * FROM matches WHERE id = ?').bind('m1').first<any>();
    expect(match.unmatched_at).not.toBeNull();
    expect(match.unmatched_by).toBe('u1');
  });

  it('ends an active match regardless of which user is user_a_id vs user_b_id', async () => {
    // Canonical sorted-pair ordering: 'u2' < 'u1' alphabetically is false ('u1' < 'u2'),
    // so use ids that sort with the blocker as user_b_id to exercise both branches.
    await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m2', 'u1', 'u2', 1000)`).run();
    const cookie = await cookieFor('u2'); // u2 is user_b_id in the row above; blocker is the "b" side
    const res = await worker.fetch(
      new Request('http://localhost/api/block', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u1' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const match = await env.DB.prepare('SELECT * FROM matches WHERE id = ?').bind('m2').first<any>();
    expect(match.unmatched_at).not.toBeNull();
    expect(match.unmatched_by).toBe('u2');
  });

  it('is idempotent on a repeat block', async () => {
    const cookie = await cookieFor('u1');
    const block = () =>
      worker.fetch(
        new Request('http://localhost/api/block', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: 'u2' }),
        }),
        env,
        {} as ExecutionContext
      );
    await block();
    const res = await block();
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare('SELECT * FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind('u1', 'u2').all();
    expect(rows.results.length).toBe(1);
  });
});

describe('GET /api/blocks', () => {
  it('lists only the caller\'s own blocks, joined with the blocked user\'s display name', async () => {
    await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind('U Two', 'u2').run();
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u1', 'u2', 1000)`).run();
    await makeUser('u3');
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b2', 'u3', 'u1', 2000)`).run(); // someone else's block

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/blocks', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();

    expect(body.blocks.length).toBe(1);
    expect(body.blocks[0].userId).toBe('u2');
    expect(body.blocks[0].displayName).toBe('U Two');
  });

  it('returns an empty list when the caller has blocked no one', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/blocks', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.blocks).toEqual([]);
  });
});

describe('POST /api/blocks/:id/unblock', () => {
  it('removes the block and sets the underlying swipe to passed (left)', async () => {
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u1', 'u2', 1000)`).run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('ps1', 'u1', 'u2', 'right', 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(
      new Request('http://localhost/api/blocks/u2/unblock', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const block = await env.DB.prepare('SELECT * FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind('u1', 'u2').first();
    expect(block).toBeNull();

    const swipe = await env.DB.prepare('SELECT direction FROM people_swipes WHERE swiper_id = ? AND target_id = ?').bind('u1', 'u2').first<any>();
    expect(swipe.direction).toBe('left');
  });

  it('does not touch someone else\'s swipe on the target', async () => {
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u1', 'u2', 1000)`).run();
    await makeUser('u3');
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('ps1', 'u1', 'u2', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('ps2', 'u3', 'u2', 'right', 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    await worker.fetch(new Request('http://localhost/api/blocks/u2/unblock', { method: 'POST', headers: { Cookie: cookie } }), env, {} as ExecutionContext);

    const othersSwipe = await env.DB.prepare('SELECT direction FROM people_swipes WHERE swiper_id = ? AND target_id = ?').bind('u3', 'u2').first<any>();
    expect(othersSwipe.direction).toBe('right'); // unaffected
  });

  it('returns 404 when there is no block between the caller and the target', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/blocks/u2/unblock', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/blocks/u2/unblock', { method: 'POST' }), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/report', () => {
  it('rejects a reason outside the fixed set', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/report', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u2', reason: 'i just do not like them' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
  });

  it('creates an open report for a valid reason', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/report', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u2', reason: 'harassment', details: 'rude messages' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM reports WHERE reporter_id = ? AND reported_id = ?').bind('u1', 'u2').first<any>();
    expect(row.status).toBe('open');
    expect(row.details).toBe('rude messages');
  });

  async function report(reporterId: string, targetId: string, reason = 'other') {
    const cookie = await cookieFor(reporterId);
    return worker.fetch(
      new Request('http://localhost/api/report', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: targetId, reason }),
      }),
      env,
      {} as ExecutionContext
    );
  }

  it('ghosts a user once 3 distinct people have reported them', async () => {
    await makeUser('u3');
    await makeUser('u4');

    await report('u1', 'u2');
    let target = await env.DB.prepare('SELECT ghosted_at FROM users WHERE id = ?').bind('u2').first<any>();
    expect(target.ghosted_at).toBeNull();

    await report('u3', 'u2');
    target = await env.DB.prepare('SELECT ghosted_at FROM users WHERE id = ?').bind('u2').first<any>();
    expect(target.ghosted_at).toBeNull();

    await report('u4', 'u2');
    target = await env.DB.prepare('SELECT ghosted_at FROM users WHERE id = ?').bind('u2').first<any>();
    expect(target.ghosted_at).not.toBeNull();
  });

  it('does not ghost from repeated reports by the same person -- distinct reporters only', async () => {
    // Otherwise one person could unilaterally ghost someone just by filing
    // the same report three times.
    await report('u1', 'u2');
    await report('u1', 'u2');
    await report('u1', 'u2');

    const target = await env.DB.prepare('SELECT ghosted_at FROM users WHERE id = ?').bind('u2').first<any>();
    expect(target.ghosted_at).toBeNull();
  });
});
