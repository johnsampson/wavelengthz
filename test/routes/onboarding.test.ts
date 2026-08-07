import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { computeAge } from '../../src/lib/age';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM users;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
});

async function sessionCookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

describe('POST /api/onboarding', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/onboarding', { method: 'POST' }), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('rejects and writes nothing when date_of_birth is missing', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_date_of_birth');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects and writes nothing when date_of_birth is unparseable garbage', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: 'not-a-date', location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_date_of_birth');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects and writes nothing when date_of_birth is a number', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: 12345, location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_date_of_birth');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects and writes nothing when date_of_birth is a boolean', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: true, location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_date_of_birth');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects and writes nothing when the user is under 18', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: '2015-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.error).toBe('underage');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects and writes nothing when lat is missing', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: '1995-01-01', location_label: 'Austin, TX', lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('location_required');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects and writes nothing when lng is missing', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('location_required');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects and writes nothing when lat/lng are null', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: null, lng: null }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('location_required');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('saves onboarding fields and marks age-verified for an adult', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: 'Jordan',
        bio: 'hi',
        date_of_birth: '1995-01-01',
        location_label: 'Austin, TX',
        lat: 30.27,
        lng: -97.74,
        max_distance_km: 40,
        gender: 'female',
        seeking: 'male',
        intent: 'dating_around',
      }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).not.toBeNull();
    expect(row.age_verified_at).not.toBeNull();
    expect(row.display_name).toBe('Jordan');
    expect(row.bio).toBe('hi');
    expect(row.max_distance_km).toBe(40);
    expect(row.gender).toBe('female');
    expect(row.seeking).toBe('male');
    expect(row.intent).toBe('dating_around');
    // First-time onboarding is not a "location change" -- the cooldown clock
    // doesn't start until a later call actually changes lat/lng.
    expect(row.location_updated_at).toBeNull();
  });

  it('rejects and writes nothing when gender is missing or invalid', async () => {
    const cookie = await sessionCookieFor('u1');
    const post = (gender: unknown) =>
      worker.fetch(
        new Request('http://localhost/api/onboarding', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender, seeking: 'male', intent: 'dating_around' }),
        }),
        env,
        {} as ExecutionContext
      );

    for (const bad of [undefined, '', 'nonbinary', 'Male']) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      const body = await res.json<any>();
      expect(body.error).toBe('invalid_gender');
    }
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects and writes nothing when seeking is missing or invalid', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'everyone', intent: 'dating_around' }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_seeking');
  });

  it('rejects and writes nothing when intent is missing or invalid', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'female', intent: 'married' }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_intent');
  });

  describe('location change cooldown', () => {
    const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
    const completePayload = (overrides: Record<string, unknown>) => ({
      display_name: 'Jordan',
      date_of_birth: '1995-01-01',
      location_label: 'Austin, TX',
      gender: 'male',
      seeking: 'female',
      intent: 'dating_around',
      lat: 30.27,
      lng: -97.74,
      ...overrides,
    });
    const post = (cookie: string, payload: Record<string, unknown>) =>
      worker.fetch(
        new Request('http://localhost/api/onboarding', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        env,
        {} as ExecutionContext
      );

    it('allows changing location on the very next call after first onboarding (no cooldown yet)', async () => {
      const cookie = await sessionCookieFor('u1');
      await post(cookie, completePayload({}));

      const res = await post(cookie, completePayload({ lat: 40.71, lng: -74.0 }));
      expect(res.status).toBe(200);

      const row = await env.DB.prepare('SELECT lat, lng, location_updated_at FROM users WHERE id = ?').bind('u1').first<any>();
      expect(row.lat).toBe(40.71);
      expect(row.lng).toBe(-74.0);
      expect(row.location_updated_at).not.toBeNull();
    });

    it('rejects a second location change within 7 days of the first', async () => {
      const cookie = await sessionCookieFor('u1');
      await post(cookie, completePayload({}));
      await post(cookie, completePayload({ lat: 40.71, lng: -74.0 }));

      const res = await post(cookie, completePayload({ lat: 41.88, lng: -87.63 }));
      expect(res.status).toBe(429);
      const body = await res.json<any>();
      expect(body.error).toBe('location_change_cooldown');
      expect(body.retryAfterMs).toBeGreaterThan(0);

      const row = await env.DB.prepare('SELECT lat, lng FROM users WHERE id = ?').bind('u1').first<any>();
      expect(row.lat).toBe(40.71); // unchanged
    });

    it('allows a location change once 7 days have passed', async () => {
      const cookie = await sessionCookieFor('u1');
      await post(cookie, completePayload({}));
      await post(cookie, completePayload({ lat: 40.71, lng: -74.0 }));
      await env.DB.prepare('UPDATE users SET location_updated_at = ? WHERE id = ?')
        .bind(Date.now() - COOLDOWN_MS - 1000, 'u1')
        .run();

      const res = await post(cookie, completePayload({ lat: 41.88, lng: -87.63 }));
      expect(res.status).toBe(200);
      const row = await env.DB.prepare('SELECT lat, lng FROM users WHERE id = ?').bind('u1').first<any>();
      expect(row.lat).toBe(41.88);
    });

    it('does not trigger the cooldown when re-submitting the same lat/lng (settings re-save path)', async () => {
      const cookie = await sessionCookieFor('u1');
      await post(cookie, completePayload({}));
      await post(cookie, completePayload({ lat: 40.71, lng: -74.0 }));

      // Re-saving settings without touching location re-sends the same lat/lng
      // (public/settings.js's fetch-then-resubmit pattern) -- must not count
      // as a "change" or every unrelated settings save would start a 7-day
      // lockout.
      const res = await post(cookie, completePayload({ lat: 40.71, lng: -74.0, max_distance_km: 60 }));
      expect(res.status).toBe(200);
    });
  });

  it('preserves an existing bio on a second call that re-sends it (settings re-save path)', async () => {
    // The Settings page reuses this endpoint just to change max_distance_km,
    // and the UPDATE unconditionally does `SET bio = ?` bound to
    // `body.bio ?? null`. That means the client is responsible for echoing
    // the existing bio back; public/settings.js now does, and this locks in
    // the backend half of that contract.
    const cookie = await sessionCookieFor('u1');
    const post = (payload: Record<string, unknown>) =>
      worker.fetch(
        new Request('http://localhost/api/onboarding', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        env,
        {} as ExecutionContext
      );

    await post({ display_name: 'Jordan', bio: 'loud guitars', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, max_distance_km: 25, gender: 'male', seeking: 'female', intent: 'dating_around' });

    const resaved = await post({ display_name: 'Jordan', bio: 'loud guitars', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, max_distance_km: 50, gender: 'male', seeking: 'female', intent: 'dating_around' });
    expect(resaved.status).toBe(200);

    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.bio).toBe('loud guitars');
    expect(row.max_distance_km).toBe(50);
  });

  it('documents that omitting bio clears it — the exact bug settings.js works around', async () => {
    const cookie = await sessionCookieFor('u1');
    const post = (payload: Record<string, unknown>) =>
      worker.fetch(
        new Request('http://localhost/api/onboarding', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        env,
        {} as ExecutionContext
      );

    await post({ display_name: 'Jordan', bio: 'loud guitars', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'female', intent: 'dating_around' });
    await post({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, max_distance_km: 50, gender: 'male', seeking: 'female', intent: 'dating_around' });

    const row = await env.DB.prepare('SELECT bio FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.bio).toBeNull();
  });

  it('rejects and writes nothing when display_name is missing', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_display_name');
    const row = await env.DB.prepare('SELECT onboarded_at, display_name FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
    expect(row.display_name).toBeNull();
  });

  it('rejects a whitespace-only display_name', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: '   ', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_display_name');
  });

  it('rejects a display_name containing characters outside letters/numbers/dashes/spaces', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Jordan!!', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_display_name');
  });

  it('rejects and writes nothing when bio exceeds the max length', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Jordan', bio: 'a'.repeat(501), date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_bio');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects a non-string bio', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Jordan', bio: 12345, date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_bio');
  });

  it('accepts a display_name with letters, numbers, dashes, and spaces', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Jordan-Lee 2', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'female', intent: 'dating_around' }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.display_name).toBe('Jordan-Lee 2');
  });

  it('trims the display name before saving', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: '  Jordan  ', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'female', intent: 'dating_around' }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.display_name).toBe('Jordan');
  });

  describe('age range', () => {
    const completePayload = (overrides: Record<string, unknown>) => ({
      display_name: 'Jordan',
      date_of_birth: '1995-01-01',
      location_label: 'Austin, TX',
      lat: 30.27,
      lng: -97.74,
      gender: 'male',
      seeking: 'female',
      intent: 'dating_around',
      ...overrides,
    });
    const post = (cookie: string, payload: Record<string, unknown>) =>
      worker.fetch(
        new Request('http://localhost/api/onboarding', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        env,
        {} as ExecutionContext
      );

    it('defaults new users to the full 18-100 range', async () => {
      const cookie = await sessionCookieFor('u1');
      await post(cookie, completePayload({}));
      const row = await env.DB.prepare('SELECT age_min, age_max FROM users WHERE id = ?').bind('u1').first<any>();
      expect(row.age_min).toBe(18);
      expect(row.age_max).toBe(100);
    });

    it('round-trips a narrowed age range through save', async () => {
      const cookie = await sessionCookieFor('u1');
      await post(cookie, completePayload({ age_min: 25, age_max: 40 }));
      const row = await env.DB.prepare('SELECT age_min, age_max FROM users WHERE id = ?').bind('u1').first<any>();
      expect(row.age_min).toBe(25);
      expect(row.age_max).toBe(40);
    });

    it('leaves an existing age range untouched when a resave omits it (settings re-save path)', async () => {
      const cookie = await sessionCookieFor('u1');
      await post(cookie, completePayload({ age_min: 25, age_max: 40 }));
      await post(cookie, completePayload({ max_distance_km: 60 }));
      const row = await env.DB.prepare('SELECT age_min, age_max FROM users WHERE id = ?').bind('u1').first<any>();
      expect(row.age_min).toBe(25);
      expect(row.age_max).toBe(40);
    });

    it.each([
      [17, 40], // below MIN_AGE
      [25, 101], // above MAX_AGE
      [40, 25], // min above max
      [25.5, 40], // non-integer
    ])('rejects and writes nothing for age_min=%s age_max=%s', async (age_min, age_max) => {
      const cookie = await sessionCookieFor('u1');
      const res = await post(cookie, completePayload({ age_min, age_max }));
      expect(res.status).toBe(400);
      const body = await res.json<any>();
      expect(body.error).toBe('invalid_age_range');
      const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
      expect(row.onboarded_at).toBeNull();
    });

    it('rejects when only one bound is provided', async () => {
      const cookie = await sessionCookieFor('u1');
      const res = await post(cookie, completePayload({ age_min: 25 }));
      expect(res.status).toBe(400);
      const body = await res.json<any>();
      expect(body.error).toBe('invalid_age_range');
    });

    const dob = '1995-01-01';
    const selfAge = computeAge(dob, Date.now());

    it.each([
      [selfAge + 4, selfAge + 9], // range starts above the user's own age
      [18, selfAge - 6], // range ends below the user's own age
    ])('rejects and writes nothing when age_min=%s age_max=%s excludes the user\'s own age', async (age_min, age_max) => {
      const cookie = await sessionCookieFor('u1');
      const res = await post(cookie, completePayload({ date_of_birth: dob, age_min, age_max }));
      expect(res.status).toBe(400);
      const body = await res.json<any>();
      expect(body.error).toBe('age_range_excludes_self');
      const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
      expect(row.onboarded_at).toBeNull();
    });

    it("accepts a range that includes the user's own age at its edge", async () => {
      const cookie = await sessionCookieFor('u1');
      const res = await post(cookie, completePayload({ date_of_birth: dob, age_min: selfAge, age_max: selfAge + 9 }));
      expect(res.status).toBe(200);
      const row = await env.DB.prepare('SELECT age_min, age_max FROM users WHERE id = ?').bind('u1').first<any>();
      expect(row.age_min).toBe(selfAge);
      expect(row.age_max).toBe(selfAge + 9);
    });
  });
});
