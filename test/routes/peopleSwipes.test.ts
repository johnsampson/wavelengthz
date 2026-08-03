import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
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
    `INSERT INTO users (id, spotify_id, lat, lng, max_distance_km, onboarded_at, email, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, 30.27, -97.74, 80, 1000, ?, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`, email).run();
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

describe('match creation dispatches a transactional email', () => {
  it('calls the Resend API for a matched user who has an email on file', async () => {
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

    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledTimes(2); // one email per matched participant

    const notifications = await env.DB.prepare("SELECT * FROM notifications WHERE type = 'match'").all<any>();
    expect(notifications.results.every((n: any) => n.email_sent_at !== null)).toBe(true);

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
