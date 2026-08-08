import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { getMatchNotificationDelayMs } from '../../src/lib/notifications';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

// gender/seeking default to the same value ('female'/'female') for every
// fixture user so mutual-compatibility filtering (added in
// GET /api/candidates/people) never excludes any pair of default test users --
// tests that specifically exercise gender/seeking filtering override these via
// makeUserWithGender.
async function makeUser(id: string) {
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, lat, lng, max_distance_km, onboarded_at, gender, seeking, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, 30.27, -97.74, 80, 1000, 'female', 'female', 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`).run();
}

async function makeUserWithGender(id: string, gender: string, seeking: string) {
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, lat, lng, max_distance_km, onboarded_at, gender, seeking, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, 30.27, -97.74, 80, 1000, ?, ?, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`, gender, seeking).run();
}

async function makeUnonboardedUser(id: string) {
  // No lat/lng/onboarded_at -- simulates a session created before onboarding
  // finished, or an account whose location was somehow never set.
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`).run();
}

async function makeUserWithEmail(id: string, email: string) {
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, lat, lng, max_distance_km, onboarded_at, gender, seeking, email, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, 30.27, -97.74, 80, 1000, 'female', 'female', ?, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`, email).run();
}

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  // Child rows before parent `users` rows -- D1 enforces FK constraints here.
  await env.DB.exec(
    'DELETE FROM notifications; DELETE FROM matches; DELETE FROM blocks; DELETE FROM people_swipes; DELETE FROM music_swipes; DELETE FROM user_genres; DELETE FROM music_profiles; DELETE FROM user_photos; DELETE FROM sessions; DELETE FROM users;'
  );
  await makeUser('u1');
  await makeUser('u2');
  await makeUser('u3');
});

describe('GET /api/candidates/people gender/seeking filtering', () => {
  it('excludes a candidate whose gender does not match what the caller is seeking', async () => {
    await makeUserWithGender('viewer', 'male', 'female'); // male, seeking female
    await makeUserWithGender('male-seeking-female', 'male', 'female'); // wrong gender for viewer's seeking
    // Right gender for the viewer's seeking, but this candidate doesn't seek
    // male back -- one-directional gender match isn't enough, it must be mutual.
    await makeUserWithGender('female-seeking-female', 'female', 'female');

    const cookie = await cookieFor('viewer');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people?limit=50', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.candidates.find((c: any) => c.id === 'male-seeking-female')).toBeUndefined();
    expect(body.candidates.find((c: any) => c.id === 'female-seeking-female')).toBeUndefined();
  });

  it('includes a candidate only when gender/seeking match in both directions', async () => {
    await makeUserWithGender('viewer', 'male', 'female');
    await makeUserWithGender('mutual', 'female', 'male');

    const cookie = await cookieFor('viewer');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people?limit=50', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.candidates.find((c: any) => c.id === 'mutual')).toBeDefined();
  });

  it('returns onboarding_incomplete for a caller with no gender/seeking set yet', async () => {
    await env.DB.prepare('UPDATE users SET gender = NULL, seeking = NULL WHERE id = ?').bind('u1').run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('onboarding_incomplete');
  });
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

  it('still shows a primaryPhotoUrl after the candidate deletes their position-0 photo', async () => {
    // Regression: DELETE /api/photos/:id used to leave a hole at position 0,
    // and primaryPhotoUrl matches strictly on `position = 0` -- so deleting
    // your first photo made you permanently photoless in everyone's deck.
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u2', 'users/u2/p1.jpg', 0, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p2', 'u2', 'users/u2/p2.jpg', 1, 2000)`
    ).run();

    const u2Cookie = await cookieFor('u2');
    const delRes = await worker.fetch(
      new Request('http://localhost/api/photos/p1', { method: 'DELETE', headers: { Cookie: u2Cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(delRes.status).toBe(200);

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    const body = await res.json<any>();
    const u2 = body.candidates.find((c: any) => c.id === 'u2');
    expect(u2.primaryPhotoUrl).toBe('/photos/p2');
  });
});

describe('max_distance_km is enforced as a filter, not just a scoring weight', () => {
  async function makeUserAt(id: string, lat: number, lng: number) {
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, lat, lng, max_distance_km, onboarded_at, gender, seeking, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 80, 1000, 'female', 'female', 'a', 'r', 9999999999999, 1000, 1000)`
    ).bind(id, `sp-${id}`, lat, lng).run();
  }

  it('never returns a candidate outside the caller\'s radius', async () => {
    // London, ~7,600km from the Austin coordinates the shared fixtures use.
    await makeUserAt('far', 51.5, -0.12);
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'far')).toBeUndefined();
    expect(body.candidates.find((c: any) => c.id === 'u2')).toBeDefined();
  });

  it('excludes a candidate just outside the radius but keeps one just inside', async () => {
    // Same longitude as the fixtures, offset purely in latitude: ~111km per
    // degree, so 0.5deg ~= 55km (inside 80km) and 1.0deg ~= 111km (outside).
    await makeUserAt('near', 30.27 + 0.5, -97.74);
    await makeUserAt('outside', 30.27 + 1.0, -97.74);
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people?limit=50', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'near')).toBeDefined();
    expect(body.candidates.find((c: any) => c.id === 'outside')).toBeUndefined();
  });

  it('respects a widened radius, admitting a candidate a narrower one excluded', async () => {
    await makeUserAt('mid', 30.27 + 1.0, -97.74); // ~111km away
    const cookie = await cookieFor('u1');

    const narrow = await worker.fetch(new Request('http://localhost/api/candidates/people?limit=50', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect((await narrow.json<any>()).candidates.find((c: any) => c.id === 'mid')).toBeUndefined();

    await env.DB.prepare('UPDATE users SET max_distance_km = ? WHERE id = ?').bind(200, 'u1').run();
    const wide = await worker.fetch(new Request('http://localhost/api/candidates/people?limit=50', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect((await wide.json<any>()).candidates.find((c: any) => c.id === 'mid')).toBeDefined();
  });

  it('excludes an out-of-radius liker from the like-priority queue too', async () => {
    await makeUserAt('far', 51.5, -0.12);
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('s1', 'far', 'u1', 'right', 0.99, 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'far')).toBeUndefined();
  });
});

describe('age_min/age_max are enforced as a filter, not just a scoring weight', () => {
  async function makeUserWithAge(id: string, dateOfBirth: string | null, ageMin = 18, ageMax = 100) {
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, lat, lng, max_distance_km, onboarded_at, gender, seeking, date_of_birth, age_min, age_max, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (?, ?, 30.27, -97.74, 80, 1000, 'female', 'female', ?, ?, ?, 'a', 'r', 9999999999999, 1000, 1000)`
    ).bind(id, `sp-${id}`, dateOfBirth, ageMin, ageMax).run();
  }

  // Fixed reference point so age-from-date_of_birth is deterministic
  // regardless of when the suite runs.
  const NOW = new Date('2026-01-01T00:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('excludes a candidate younger than the caller\'s minimum age', async () => {
    await env.DB.prepare('UPDATE users SET age_min = 30, age_max = 100 WHERE id = ?').bind('u1').run();
    await makeUserWithAge('young', '2005-06-01'); // 20 years old
    await makeUserWithAge('old-enough', '1990-06-01'); // 35 years old

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people?limit=50', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'young')).toBeUndefined();
    expect(body.candidates.find((c: any) => c.id === 'old-enough')).toBeDefined();
  });

  it('excludes a candidate older than the caller\'s maximum age', async () => {
    await env.DB.prepare('UPDATE users SET age_min = 18, age_max = 30 WHERE id = ?').bind('u1').run();
    await makeUserWithAge('too-old', '1980-06-01'); // 45 years old
    await makeUserWithAge('in-range', '2000-06-01'); // 25 years old

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people?limit=50', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'too-old')).toBeUndefined();
    expect(body.candidates.find((c: any) => c.id === 'in-range')).toBeDefined();
  });

  it('never excludes a candidate with no date_of_birth on record', async () => {
    // Every real onboarded account has date_of_birth set, but a candidate row
    // that predates the field (or the shared test fixtures, which never set
    // it) must not be silently hidden just because an age can't be computed.
    await env.DB.prepare('UPDATE users SET age_min = 30, age_max = 40 WHERE id = ?').bind('u1').run();

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people?limit=50', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'u2')).toBeDefined();
  });

  it('excludes an out-of-age-range liker from the like-priority queue too', async () => {
    await env.DB.prepare('UPDATE users SET age_min = 30, age_max = 100 WHERE id = ?').bind('u1').run();
    await makeUserWithAge('young-liker', '2005-06-01'); // 20 years old
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('s1', 'young-liker', 'u1', 'right', 0.99, 1000, 1000)`
    ).run();

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'young-liker')).toBeUndefined();
  });
});

describe('GET /api/candidates/people query count does not scale with pool size', () => {
  // The route used to issue ~5 DB queries per candidate (4 from scoreCandidate,
  // 2 of which re-read the *caller's* unchanging data, plus a primaryPhotoUrl
  // lookup). With a 200-candidate pool that is 1000+ subrequests -- at or past
  // the Workers per-request limit, so the whole deck 500s with "Too many
  // subrequests" rather than merely being slow. Assert the count is flat.
  function countingEnv() {
    let prepareCount = 0;
    const db = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (...args: any[]) => {
            prepareCount += 1;
            return (target as any).prepare(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return { proxied: { ...env, DB: db } as any, count: () => prepareCount };
  }

  async function seedPool(count: number) {
    for (let i = 0; i < count; i++) {
      const id = `pool${i}`;
      await env.DB.prepare(
        `INSERT INTO users (id, spotify_id, lat, lng, max_distance_km, onboarded_at, access_token, refresh_token, token_expires_at, created_at, updated_at)
         VALUES (?, ?, 30.27, -97.74, 80, 1000, 'a', 'r', 9999999999999, 1000, 1000)`
      ).bind(id, `sp-${id}`).run();
      await env.DB.prepare(
        `INSERT INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at)
         VALUES (?, '[{"artist_id":"a1","rank":1}]', '[]', '["pop"]', 'medium_term', 1000)`
      ).bind(id).run();
      await env.DB.prepare(
        `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at)
         VALUES (?, ?, 'artist', 'a1', 'right', 1000, 1000)`
      ).bind(`msw-${id}`, id).run();
    }
  }

  async function queryCountForPool(size: number) {
    await seedPool(size);
    const cookie = await cookieFor('u1');
    const { proxied, count } = countingEnv();
    const res = await worker.fetch(
      new Request('http://localhost/api/candidates/people?limit=10', { headers: { Cookie: cookie } }),
      proxied,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    return count();
  }

  it('issues the same number of queries for a 40-candidate pool as for a 4-candidate one', async () => {
    const small = await queryCountForPool(4);

    await env.DB.exec('DELETE FROM music_swipes; DELETE FROM music_profiles;');
    await env.DB.exec("DELETE FROM users WHERE id LIKE 'pool%';");

    const large = await queryCountForPool(40);

    expect(large).toBe(small);
    // Session lookup + like-priority + pool + 2 batched scoring loads + photos.
    expect(small).toBeLessThanOrEqual(8);
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

  it('returns matchId in the response so the deck can show a celebration', async () => {
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

    const res = await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie2, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'u1', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    const body = await res.json<any>();
    expect(body.matched).toBe(true);
    expect(body.matchId).toBeTruthy();

    const match = await env.DB.prepare('SELECT id FROM matches').first<any>();
    expect(body.matchId).toBe(match.id);
  });

  it('omits matchId when the swipe does not complete a match', async () => {
    const cookie1 = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie1, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'u2', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    const body = await res.json<any>();
    expect(body.matched).toBe(false);
    expect(body.matchId).toBeUndefined();
  });
});

describe('match creation defers the transactional email', () => {
  // Match-notification emails are no longer sent synchronously on match
  // creation -- they're deferred (src/lib/notifications.ts's
  // getMatchNotificationDelayMs, swept by the scheduled() cron) so the
  // person who just matched has a window to unmatch before anyone is
  // emailed. See test/lib/notifications.test.ts for the sweep's own behavior.
  it('creates notification rows but does not call the Resend API immediately', async () => {
    await makeUserWithEmail('e1', 'e1@example.com');
    await makeUserWithEmail('e2', 'e2@example.com');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const cookie1 = await cookieFor('e1');
    const cookie2 = await cookieFor('e2');

    await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie1, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'e2', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(fetchMock).not.toHaveBeenCalled(); // no match yet -- one-directional swipe

    await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie2, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'e1', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );

    expect(fetchMock).not.toHaveBeenCalled(); // still deferred, even after the match completes

    const notifications = await env.DB.prepare("SELECT * FROM notifications WHERE type = 'match'").all<any>();
    expect(notifications.results.length).toBe(2); // one row per matched participant
    expect(notifications.results.every((n: any) => n.email_sent_at === null)).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe('match creation survives an email-provider outage', () => {
  it('still returns matched: true and commits the match even when Resend errors', async () => {
    await makeUserWithEmail('e1', 'e1@example.com');
    await makeUserWithEmail('e2', 'e2@example.com');
    // Resend returns a non-2xx for every call -- sendEmail throws.
    const fetchMock = vi.fn(async () => new Response('service unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const cookie1 = await cookieFor('e1');
    const cookie2 = await cookieFor('e2');

    await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie1, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'e2', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );

    const res = await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie2, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'e1', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );

    // The Resend call was attempted (and failed), but the caller still gets
    // a clean 200 with matched: true -- the DB write already succeeded and
    // email delivery is best-effort, not a precondition for the response.
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.matched).toBe(true);

    const matches = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matches.results.length).toBe(1);

    vi.unstubAllGlobals();
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
    // `name`, not `displayName` -- matches the field music-mode history already
    // uses (src/routes/musicSwipes.ts), so the shared history.html/history.js
    // frontend doesn't need mode-specific field mapping. Regression: this used
    // to be `displayName`, which the frontend never read, silently falling
    // back to the raw target_id UUID for every people-mode history row.
    expect(history.swipes[0].name).toBe('U Two');

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

  it('creates a match when changing a past decision to right completes a mutual like', async () => {
    // Regression: u2 already liked u1 (a real prior right-swipe). u1 originally
    // passed on u2, then later used the History "Change" toggle to flip that
    // decision to right -- this must complete the mutual like and create a
    // match, exactly like a fresh right-swipe through the deck would.
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('ps-u2-u1', 'u2', 'u1', 'right', 0.5, 500, 500)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('ps-u1-u2', 'u1', 'u2', 'left', 0.4, 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    const patchRes = await worker.fetch(
      new Request('http://localhost/api/swipes/people/ps-u1-u2', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(patchRes.status).toBe(200);
    const body = await patchRes.json<any>();
    expect(body.matched).toBe(true);

    const [a, b] = ['u1', 'u2'].sort();
    const match = await env.DB.prepare('SELECT * FROM matches WHERE user_a_id = ? AND user_b_id = ?').bind(a, b).first<any>();
    expect(match).not.toBeNull();
    expect(body.matchId).toBe(match.id);
  });

  it('does not create a match when changing a decision to left', async () => {
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('ps-u2-u1', 'u2', 'u1', 'right', 0.5, 500, 500)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('ps-u1-u2', 'u1', 'u2', 'right', 0.4, 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    const patchRes = await worker.fetch(
      new Request('http://localhost/api/swipes/people/ps-u1-u2', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'left' }),
      }),
      env,
      {} as ExecutionContext
    );
    const body = await patchRes.json<any>();
    expect(body.matched).toBe(false);

    const [a, b] = ['u1', 'u2'].sort();
    const match = await env.DB.prepare('SELECT * FROM matches WHERE user_a_id = ? AND user_b_id = ?').bind(a, b).first();
    expect(match).toBeNull();
  });

  it('filters history by direction when ?direction= is given', async () => {
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('ps1', 'u1', 'u2', 'left', 0.4, 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('ps2', 'u1', 'u3', 'right', 0.6, 2000, 2000)`
    ).run();
    const cookie = await cookieFor('u1');

    const rightRes = await worker.fetch(
      new Request('http://localhost/api/swipes/people?direction=right', { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    const rightBody = await rightRes.json<any>();
    expect(rightBody.swipes.map((s: any) => s.id)).toEqual(['ps2']);

    const leftRes = await worker.fetch(
      new Request('http://localhost/api/swipes/people?direction=left', { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    const leftBody = await leftRes.json<any>();
    expect(leftBody.swipes.map((s: any) => s.id)).toEqual(['ps1']);
  });
});

describe('GET /api/people/:id/profile', () => {
  it('returns photos, bio, distance, and overlap for an eligible target', async () => {
    await env.DB.prepare(`UPDATE users SET bio = 'hi there', display_name = 'U Two' WHERE id = 'u2'`).run();
    await env.DB.prepare(`INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u2', 'users/u2/p1.jpg', 0, 1000)`).run();
    await env.DB.prepare(`INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p2', 'u2', 'users/u2/p2.jpg', 1, 2000)`).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u2/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();

    expect(body.profile.displayName).toBe('U Two');
    expect(body.profile.bio).toBe('hi there');
    expect(body.profile.photoUrls).toEqual(['/photos/p1', '/photos/p2']);
    expect(body.profile.distanceLabel).toContain('mile');
    expect(body.profile.likedYou).toBe(false);
    expect(body.profile.isMatch).toBe(false);
    expect(body.overlap).toEqual({ sharedArtists: [], sharedTracks: [], sharedGenres: [] });
  });

  it('includes the target\'s own top Spotify genres/artists/tracks (not overlap) on a cross-view', async () => {
    const topArtists = JSON.stringify([{ artist_id: 'sp-a1', rank: 1, name: 'Their Fave Artist', imageUrl: 'https://img/a1.jpg' }]);
    const topTracks = JSON.stringify([{ track_id: 'sp-t1', rank: 1, name: 'Their Fave Track', imageUrl: 'https://img/t1.jpg' }]);
    await env.DB.prepare(
      `INSERT INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at) VALUES ('u2', ?, ?, '["indie","pop"]', 'medium_term', 1000)`
    ).bind(topArtists, topTracks).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u2/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.profile.topGenres).toEqual(['indie', 'pop']);
    expect(body.profile.topArtists).toEqual([{ id: 'sp-a1', name: 'Their Fave Artist', imageUrl: 'https://img/a1.jpg' }]);
    expect(body.profile.topTracks).toEqual([{ id: 'sp-t1', spotifyId: 'sp-t1', name: 'Their Fave Track', imageUrl: 'https://img/t1.jpg' }]);
  });

  it('includes the caller\'s own top Spotify genres/artists/tracks on self-preview', async () => {
    const topArtists = JSON.stringify([{ artist_id: 'sp-a2', rank: 1, name: 'My Fave Artist', imageUrl: 'https://img/a2.jpg' }]);
    await env.DB.prepare(
      `INSERT INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at) VALUES ('u1', ?, '[]', '["rock"]', 'medium_term', 1000)`
    ).bind(topArtists).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u1/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.profile.topGenres).toEqual(['rock']);
    expect(body.profile.topArtists).toEqual([{ id: 'sp-a2', name: 'My Fave Artist', imageUrl: 'https://img/a2.jpg' }]);
  });

  it('reports likedYou when the target already swiped right on the caller', async () => {
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('ps1', 'u2', 'u1', 'right', 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u2/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.profile.likedYou).toBe(true);
  });

  it('reports isMatch when there is an active match', async () => {
    const [a, b] = ['u1', 'u2'].sort();
    await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m1', ?, ?, 1000)`).bind(a, b).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u2/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.profile.isMatch).toBe(true);
    expect(body.profile.matchId).toBe('m1');
  });

  it('hides isMatch/matchId for a match less than the delay old -- passive discovery only', async () => {
    const [a, b] = ['u1', 'u2'].sort();
    const delayMs = getMatchNotificationDelayMs(env);
    await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m1', ?, ?, ?)`).bind(a, b, Date.now() - (delayMs - 60 * 1000)).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u2/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.profile.isMatch).toBe(false);
    expect(body.profile.matchId).toBeNull();
  });

  it('reveals isMatch/matchId once the delay has passed', async () => {
    const [a, b] = ['u1', 'u2'].sort();
    const delayMs = getMatchNotificationDelayMs(env);
    await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m1', ?, ?, ?)`).bind(a, b, Date.now() - (delayMs + 60 * 1000)).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u2/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.profile.isMatch).toBe(true);
    expect(body.profile.matchId).toBe('m1');
  });

  it('omits matchId when there is no active match', async () => {
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u2/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.profile.isMatch).toBe(false);
    expect(body.profile.matchId).toBeNull();
  });

  it('returns 403 for a blocked target, in either direction', async () => {
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u1', 'u2', 1000)`).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u2/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('returns 404 for a soft-deleted target', async () => {
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(2000, 'u2').run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u2/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(404);
  });

  it('allows previewing your own profile, flagged isSelf, with no overlap/likedYou/isMatch computed', async () => {
    await env.DB.prepare(`UPDATE users SET bio = 'my bio', display_name = 'U One' WHERE id = 'u1'`).run();
    await env.DB.prepare(`INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u1', 'users/u1/p1.jpg', 0, 1000)`).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u1/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();

    expect(body.profile.isSelf).toBe(true);
    expect(body.profile.displayName).toBe('U One');
    expect(body.profile.bio).toBe('my bio');
    expect(body.profile.photoUrls).toEqual(['/photos/p1']);
    expect(body.profile.likedYou).toBe(false);
    expect(body.profile.isMatch).toBe(false);
    expect(body.profile.matchId).toBeNull();
    expect(body.overlap).toEqual({ sharedArtists: [], sharedTracks: [], sharedGenres: [] });
    expect(body.profile.recentArtists).toEqual([]);
    expect(body.profile.recentTracks).toEqual([]);
  });

  it('includes the caller\'s own recent right-swiped artists/tracks in self-preview, most recent first', async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, name, genres, image_url, source, approved, created_at) VALUES ('art1', 'Older Artist', '{}', '/a1.jpg', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO artists (id, name, genres, image_url, source, approved, created_at) VALUES ('art2', 'Newer Artist', '{}', '/a2.jpg', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, album_image_url, source, approved, created_at) VALUES ('trk1', 'A Track', 'art1', '/t1.jpg', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('ms1', 'u1', 'artist', 'art1', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('ms2', 'u1', 'artist', 'art2', 'right', 2000, 2000)`
    ).run();
    // A left-swipe (pass) must not show up as "recent taste".
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('ms3', 'u1', 'track', 'trk1', 'left', 3000, 3000)`
    ).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u1/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.profile.recentArtists).toEqual([
      { id: 'art2', name: 'Newer Artist', imageUrl: '/a2.jpg' },
      { id: 'art1', name: 'Older Artist', imageUrl: '/a1.jpg' },
    ]);
    expect(body.profile.recentTracks).toEqual([]);
  });

  it('includes spotifyId on recentTracks, for the embed player -- but not on recentArtists', async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('art-recent-1', 'An Artist', '{}', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, album_image_url, source, approved, created_at) VALUES ('trk-recent-1', 'sp-trk-recent-1', 'A Track', 'art-recent-1', '/t1.jpg', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('ms1', 'u1', 'artist', 'art-recent-1', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('ms2', 'u1', 'track', 'trk-recent-1', 'right', 2000, 2000)`
    ).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/people/u1/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.profile.recentTracks).toEqual([{ id: 'trk-recent-1', spotifyId: 'sp-trk-recent-1', name: 'A Track', imageUrl: '/t1.jpg' }]);
    expect(body.profile.recentArtists).toEqual([{ id: 'art-recent-1', name: 'An Artist', imageUrl: null }]);
  });

  it('rejects when the caller has not completed onboarding', async () => {
    await makeUnonboardedUser('u4');
    const cookie = await cookieFor('u4');
    const res = await worker.fetch(new Request('http://localhost/api/people/u2/profile', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('onboarding_incomplete');
  });
});

describe('onboarding-incomplete guard (Null Island prevention)', () => {
  it('rejects GET /api/candidates/people with 400 when the caller has no lat/lng/onboarded_at', async () => {
    await makeUnonboardedUser('u4');
    const cookie = await cookieFor('u4');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('onboarding_incomplete');
  });

  it('rejects POST /api/swipe/people with 400 when the caller has no lat/lng/onboarded_at', async () => {
    await makeUnonboardedUser('u4');
    const cookie = await cookieFor('u4');
    const res = await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'u1', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('onboarding_incomplete');
    const swipeRow = await env.DB.prepare('SELECT * FROM people_swipes WHERE swiper_id = ?').bind('u4').first<any>();
    expect(swipeRow).toBeNull();
  });

  it('excludes an unonboarded (no lat/lng) user from the like-priority queue even if they swiped right on the caller', async () => {
    // u4 has no lat/lng but somehow has a right-swipe row on u1 -- should never
    // surface as a like-priority candidate since scoring them would be bogus.
    await makeUnonboardedUser('u4');
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('s1', 'u4', 'u1', 'right', 0.9, 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'u4')).toBeUndefined();
  });
});

describe('POST /api/swipe/people rejects a soft-deleted target', () => {
  it('returns 400 unknown target_id when the target has been soft-deleted', async () => {
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(2000, 'u2').run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'u2', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('unknown target_id');
    const swipeRow = await env.DB.prepare('SELECT * FROM people_swipes WHERE swiper_id = ? AND target_id = ?').bind('u1', 'u2').first<any>();
    expect(swipeRow).toBeNull();
  });
});

describe('ghosted users (src/lib/reports.ts)', () => {
  it('excludes a ghosted user from the normal candidate pool', async () => {
    await env.DB.prepare('UPDATE users SET ghosted_at = ? WHERE id = ?').bind(2000, 'u2').run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people?limit=50', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'u2')).toBeUndefined();
  });

  it('excludes a ghosted liker from the like-priority queue', async () => {
    await env.DB.prepare('UPDATE users SET ghosted_at = ? WHERE id = ?').bind(2000, 'u2').run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('s1', 'u2', 'u1', 'right', 0.99, 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'u2')).toBeUndefined();
  });

  it('does not affect a ghosted user\'s own candidate deck -- ghosting only hides someone from others', async () => {
    await env.DB.prepare('UPDATE users SET ghosted_at = ? WHERE id = ?').bind(2000, 'u1').run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people?limit=50', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    // u2 and u3 (both non-ghosted, from the shared beforeEach) still show up normally.
    expect(body.candidates.find((c: any) => c.id === 'u2')).toBeDefined();
  });

  it('returns 400 unknown target_id when swiping on a ghosted user', async () => {
    await env.DB.prepare('UPDATE users SET ghosted_at = ? WHERE id = ?').bind(2000, 'u2').run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'u2', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('unknown target_id');
  });

  it('blocks a non-self lookup of a ghosted user\'s profile, but allows self-view', async () => {
    await env.DB.prepare('UPDATE users SET ghosted_at = ? WHERE id = ?').bind(2000, 'u2').run();

    const viewerCookie = await cookieFor('u1');
    const viewerRes = await worker.fetch(new Request('http://localhost/api/people/u2/profile', { headers: { Cookie: viewerCookie } }), env, {} as ExecutionContext);
    expect(viewerRes.status).toBe(404);

    const selfCookie = await cookieFor('u2');
    const selfRes = await worker.fetch(new Request('http://localhost/api/people/u2/profile', { headers: { Cookie: selfCookie } }), env, {} as ExecutionContext);
    expect(selfRes.status).toBe(200);
    const selfBody = await selfRes.json<any>();
    expect(selfBody.profile.isSelf).toBe(true);
  });
});

describe('blocks enforced at the swipe/match-creation layer', () => {
  it('rejects swiping on someone you have blocked, with 403 and no swipe written', async () => {
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u1', 'u2', 1000)`).run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'u2', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.error).toBe('blocked');
    const swipeRow = await env.DB.prepare('SELECT * FROM people_swipes WHERE swiper_id = ? AND target_id = ?').bind('u1', 'u2').first<any>();
    expect(swipeRow).toBeNull();
  });

  it('rejects swiping on someone who has blocked you, with 403', async () => {
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u2', 'u1', 1000)`).run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'u2', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.error).toBe('blocked');
  });

  it('does not create a match even when a prior mutual-right exists and a block is then added', async () => {
    // u2 already swiped right on u1 before the block existed.
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('s1', 'u2', 'u1', 'right', 0.9, 1000, 1000)`
    ).run();
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u1', 'u2', 1000)`).run();

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'u2', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);

    const matches = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matches.results.length).toBe(0);
  });
});

describe('blocked-user exclusion from candidate queries (permanent regression coverage)', () => {
  it('excludes a blocked user from the blocker\'s normal candidate pool', async () => {
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u1', 'u2', 1000)`).run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'u2')).toBeUndefined();
    expect(body.candidates.find((c: any) => c.id === 'u3')).toBeDefined();
  });

  it('excludes the blocker from the blocked user\'s normal candidate pool (reverse direction)', async () => {
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u1', 'u2', 1000)`).run();
    const cookie = await cookieFor('u2');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'u1')).toBeUndefined();
    expect(body.candidates.find((c: any) => c.id === 'u3')).toBeDefined();
  });

  it('excludes a blocked liker from the target\'s like-priority queue', async () => {
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('s1', 'u2', 'u1', 'right', 0.9, 1000, 1000)`
    ).run();
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u1', 'u2', 1000)`).run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'u2')).toBeUndefined();
  });

  it('excludes the liker from their own like-priority queue view if the target later blocked them (reverse direction)', async () => {
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('s1', 'u1', 'u2', 'right', 0.9, 1000, 1000)`
    ).run();
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u2', 'u1', 1000)`).run();
    const cookie = await cookieFor('u2');
    const req = new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.find((c: any) => c.id === 'u1')).toBeUndefined();
  });
});
