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
    `INSERT INTO users (id, spotify_id, lat, lng, max_distance_km, onboarded_at, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, 30.27, -97.74, 80, 1000, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`).run();
}

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  // Child rows before parent `users` rows -- D1 enforces FK constraints here.
  await env.DB.exec(
    'DELETE FROM notifications; DELETE FROM matches; DELETE FROM blocks; DELETE FROM people_swipes; DELETE FROM user_photos; DELETE FROM sessions; DELETE FROM users;'
  );
  await makeUser('u1');
  await makeUser('u2');
  await makeUser('u3');
});

describe('GET /api/candidates/people', () => {
  it('never exposes raw lat/lng, only a distance label', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(JSON.stringify(body)).not.toMatch(/30\.2/);
    expect(body.candidates[0].distanceLabel).toBeTruthy();
  });

  it('surfaces someone who already liked me at the front of the queue', async () => {
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('s1', 'u2', 'u1', 'right', 0.9, 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates[0].id).toBe('u2');
    expect(body.candidates[0].likedYou).toBe(true);
  });

  it('sets primaryPhotoUrl from the position-0 photo, or null with no photos', async () => {
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u2', 'users/u2/p1.jpg', 0, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    const u2 = body.candidates.find((c: any) => c.id === 'u2');
    const u3 = body.candidates.find((c: any) => c.id === 'u3');
    expect(u2.primaryPhotoUrl).toBe('/photos/p1');
    expect(u3.primaryPhotoUrl).toBeNull();
  });
});

describe('POST /api/swipe/people', () => {
  it('creates a match on the second mutual right swipe', async () => {
    const cookie1 = await cookieFor('u1');
    const cookie2 = await cookieFor('u2');

    await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie1, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'u2', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );

    let matches = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matches.results.length).toBe(0);

    await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie2, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'u1', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );

    matches = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matches.results.length).toBe(1);

    const swipeRow = await env.DB.prepare('SELECT match_score FROM people_swipes WHERE swiper_id = ? AND target_id = ?').bind('u1', 'u2').first<any>();
    expect(swipeRow.match_score).not.toBeNull();
  });
});

describe('GET /api/swipes/people and PATCH', () => {
  it('lists history joined with the target display name and allows changing a past decision', async () => {
    await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind('U Two', 'u2').run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('ps1', 'u1', 'u2', 'left', 0.4, 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    const historyRes = await worker.fetch(new Request('http://localhost/api/swipes/people', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const history = await historyRes.json<any>();
    expect(history.swipes[0].direction).toBe('left');
    expect(history.swipes[0].displayName).toBe('U Two');

    const patchRes = await worker.fetch(
      new Request('http://localhost/api/swipes/people/ps1', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(patchRes.status).toBe(200);
    const row = await env.DB.prepare('SELECT direction FROM people_swipes WHERE id = ?').bind('ps1').first<any>();
    expect(row.direction).toBe('right');
  });
});
