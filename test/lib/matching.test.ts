import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createMatchIfMutual, scoreCandidate } from '../../src/lib/matching';
import { insertTestUser } from '../helpers/createUser';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function makeUser(id: string, lat: number, lng: number) {
  await insertTestUser(env.DB, { id, spotifyId: `sp-${id}`, lat, lng, maxDistanceKm: 80, createdAt: 1000, updatedAt: 1000 });
}

beforeEach(async () => {
  // Child rows before parent `users` rows -- D1 enforces FK constraints here.
  await env.DB.exec(
    'DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM notifications; DELETE FROM matches; DELETE FROM blocks; DELETE FROM people_swipes; DELETE FROM users;'
  );
  await makeUser('u1', 30.27, -97.74);
  await makeUser('u2', 30.28, -97.75);
});

describe('scoreCandidate', () => {
  it('returns a score in [0,1] and a positive distance for two nearby users', async () => {
    const me = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first<any>();
    const candidate = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u2').first<any>();
    const { score, distanceKm } = await scoreCandidate(env.DB, me, candidate, false);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(distanceKm).toBeGreaterThan(0);
  });

  it('scores higher when alreadyLikedMe is true, all else equal', async () => {
    const me = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first<any>();
    const candidate = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u2').first<any>();
    const without = await scoreCandidate(env.DB, me, candidate, false);
    const withBoost = await scoreCandidate(env.DB, me, candidate, true);
    expect(withBoost.score).toBeGreaterThan(without.score);
  });
});

describe('createMatchIfMutual', () => {
  it('does nothing on a one-directional right swipe', async () => {
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'u2', 'right', 1000, 1000)`
    ).run();
    const result = await createMatchIfMutual(env.DB, 'u1', 'u2');
    expect(result).toBeNull();
  });

  it('creates exactly one match row and two match notifications on mutual right swipes, regardless of id order', async () => {
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('s1', 'u2', 'u1', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('s2', 'u1', 'u2', 'right', 1000, 1000)`
    ).run();

    const result = await createMatchIfMutual(env.DB, 'u1', 'u2');
    expect(result).not.toBeNull();

    const matches = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matches.results.length).toBe(1);

    const notifications = await env.DB.prepare("SELECT * FROM notifications WHERE type = 'match'").all<any>();
    expect(notifications.results.length).toBe(2);
    expect(notifications.results.every((n: any) => n.email_sent_at === null)).toBe(true);

    const second = await createMatchIfMutual(env.DB, 'u2', 'u1');
    expect(second).toBeNull(); // already matched, no duplicate

    const matchesAfter = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matchesAfter.results.length).toBe(1);
  });

  it('does nothing if the two users have blocked each other, even with mutual right swipes recorded (defense in depth)', async () => {
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('s1', 'u2', 'u1', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('s2', 'u1', 'u2', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u1', 'u2', 1000)`
    ).run();

    const result = await createMatchIfMutual(env.DB, 'u1', 'u2');
    expect(result).toBeNull();

    const matches = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matches.results.length).toBe(0);

    const reverseResult = await createMatchIfMutual(env.DB, 'u2', 'u1');
    expect(reverseResult).toBeNull();

    const matchesAfter = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matchesAfter.results.length).toBe(0);
  });

  it('does nothing outside either side\'s stated age range, even with mutual right swipes recorded (defense in depth)', async () => {
    // GET /api/candidates/people already filters this at the discovery
    // level, but that's a display filter a client could bypass by calling
    // POST /api/swipe/people directly with an arbitrary target_id. u2 (20)
    // is within u1's range (18-100), but u1 (40) is outside u2's own
    // stated range (18-25) -- the match must not be created regardless of
    // the mutual right-swipes existing.
    await env.DB.prepare('UPDATE users SET date_of_birth = ?, age_min = 18, age_max = 100 WHERE id = ?').bind('1986-01-01', 'u1').run();
    await env.DB.prepare('UPDATE users SET date_of_birth = ?, age_min = 18, age_max = 25 WHERE id = ?').bind('2006-01-01', 'u2').run();

    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('s1', 'u2', 'u1', 'right', ?, ?)`
    ).bind(new Date('2026-06-01').getTime(), new Date('2026-06-01').getTime()).run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('s2', 'u1', 'u2', 'right', ?, ?)`
    ).bind(new Date('2026-06-01').getTime(), new Date('2026-06-01').getTime()).run();

    const result = await createMatchIfMutual(env.DB, 'u1', 'u2');
    expect(result).toBeNull();

    const matches = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matches.results.length).toBe(0);
  });

  it('does nothing if either party is ghosted, even with mutual right swipes recorded (defense in depth)', async () => {
    // GET /api/candidates/people already filters this at the discovery
    // level, but a client could still call POST /api/swipe/people directly
    // with an arbitrary target_id, bypassing it entirely.
    await env.DB.prepare('UPDATE users SET ghosted_at = ? WHERE id = ?').bind(1000, 'u2').run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('s3', 'u2', 'u1', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('s4', 'u1', 'u2', 'right', 1000, 1000)`
    ).run();

    const result = await createMatchIfMutual(env.DB, 'u1', 'u2');
    expect(result).toBeNull();

    const matches = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matches.results.length).toBe(0);
  });
});
