import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function makeUser(id: string) {
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`).run();
}

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  // Child rows before parent `users` rows -- D1 enforces FK constraints here.
  // blocks, reports, matches, and sessions all reference users(id).
  await env.DB.exec('DELETE FROM blocks; DELETE FROM reports; DELETE FROM matches; DELETE FROM sessions; DELETE FROM users;');
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
});
