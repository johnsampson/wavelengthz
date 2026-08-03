import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM music_swipes; DELETE FROM sessions; DELETE FROM users; DELETE FROM artists;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(`INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('a1', 'Artist One', '[]', 'seed', 1, 1000)`).run();
  await env.DB.prepare(`INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('a2', 'Artist Two', '[]', 'seed', 1, 1000)`).run();
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

describe('GET /api/candidates/music', () => {
  it('excludes artists the user has already swiped on', async () => {
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'right', 1000, 1000)`
    ).run();
    const req = new Request('http://localhost/api/candidates/music', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.map((c: any) => c.itemId)).toEqual(['a2']);
  });
});

describe('POST /api/swipe/music', () => {
  it('creates a swipe and upserts direction on repeat swipe', async () => {
    const cookie = await cookieFor('u1');
    const swipe = (direction: string) =>
      worker.fetch(
        new Request('http://localhost/api/swipe/music', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_type: 'artist', item_id: 'a1', direction }),
        }),
        env,
        {} as ExecutionContext
      );

    await swipe('left');
    let row = await env.DB.prepare('SELECT * FROM music_swipes WHERE user_id = ? AND item_id = ?').bind('u1', 'a1').first<any>();
    expect(row.direction).toBe('left');

    await swipe('right');
    const rows = await env.DB.prepare('SELECT * FROM music_swipes WHERE user_id = ? AND item_id = ?').bind('u1', 'a1').all<any>();
    expect(rows.results.length).toBe(1); // upsert, not a second row
    expect(rows.results[0].direction).toBe('right');
  });
});

describe('GET /api/swipes/music and PATCH', () => {
  it('lists history and allows changing a past decision', async () => {
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'left', 1000, 1000)`
    ).run();

    const historyRes = await worker.fetch(new Request('http://localhost/api/swipes/music', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const history = await historyRes.json<any>();
    expect(history.swipes[0].direction).toBe('left');
    expect(history.swipes[0].name).toBe('Artist One');

    const patchRes = await worker.fetch(
      new Request('http://localhost/api/swipes/music/s1', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(patchRes.status).toBe(200);
    const row = await env.DB.prepare('SELECT direction FROM music_swipes WHERE id = ?').bind('s1').first<any>();
    expect(row.direction).toBe('right');
  });

  it('rejects patching a swipe owned by another user', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES ('u2', 'sp2', 'a', 'r', 9999999999999, 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'left', 1000, 1000)`
    ).run();
    const before = await env.DB.prepare('SELECT direction, updated_at FROM music_swipes WHERE id = ?').bind('s1').first<any>();

    const u2cookie = await cookieFor('u2');
    const patchRes = await worker.fetch(
      new Request('http://localhost/api/swipes/music/s1', {
        method: 'PATCH',
        headers: { Cookie: u2cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(patchRes.status).toBe(404);

    const after = await env.DB.prepare('SELECT direction, updated_at FROM music_swipes WHERE id = ?').bind('s1').first<any>();
    expect(after.direction).toBe(before.direction);
    expect(after.updated_at).toBe(before.updated_at);
  });
});
