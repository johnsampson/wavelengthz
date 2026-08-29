import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import { computeAge } from '../../src/lib/age';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM invite_codes; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM sessions; DELETE FROM users;'
  );
  await insertTestUser(env.DB, {
    id: 'u1',
    spotifyId: 'sp1',
    accessToken: 'a',
    refreshToken: 'r',
    tokenExpiresAt: 9999999999999,
    createdAt: 1000,
    updatedAt: 1000,
  });
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
        intent: 'something_casual',
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
    expect(row.intent).toBe('something_casual');
    // First-time onboarding is not a "location change" -- the cooldown clock
    // doesn't start until a later call actually changes lat/lng.
    expect(row.location_updated_at).toBeNull();
  });

  // Issue #145 (Round 7) item 3: "is it easy to translate lat lon on file
  // to a city or state/region or country?" -- the browser-geolocation path
  // (public/onboarding.html's/public/settings/preferences.js's
  // useBrowserLocation()) sends the literal "Current location" placeholder
  // as location_label; this route now resolves it via BigDataCloud's
  // reverse-geocode-client endpoint (src/lib/geocode.ts) before persisting.
  describe('reverse geocoding "Current location"', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubGeocode(payload: Record<string, unknown>, status = 200) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo) => {
          const url = input.toString();
          if (url.includes('bigdatacloud.net')) return new Response(JSON.stringify(payload), { status });
          throw new Error(`unexpected fetch ${url}`);
        })
      );
    }

    it('replaces the placeholder with a resolved "City, Region" label', async () => {
      stubGeocode({ city: 'Austin', principalSubdivision: 'Texas', countryName: 'United States' });
      const cookie = await sessionCookieFor('u1');

      const res = await worker.fetch(
        new Request('http://localhost/api/onboarding', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            display_name: 'Jordan',
            date_of_birth: '1995-01-01',
            location_label: 'Current location',
            lat: 30.27,
            lng: -97.74,
            gender: 'female',
            seeking: 'male',
            intent: 'something_casual',
          }),
        }),
        env,
        {} as ExecutionContext
      );

      expect(res.status).toBe(200);
      const row = await env.DB.prepare('SELECT location_label FROM users WHERE id = ?').bind('u1').first<any>();
      expect(row.location_label).toBe('Austin, Texas');
    });

    it('leaves a manually-typed label untouched -- no geocode call at all', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const cookie = await sessionCookieFor('u1');

      await worker.fetch(
        new Request('http://localhost/api/onboarding', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            display_name: 'Jordan',
            date_of_birth: '1995-01-01',
            location_label: 'My Hometown',
            lat: 30.27,
            lng: -97.74,
            gender: 'female',
            seeking: 'male',
            intent: 'something_casual',
          }),
        }),
        env,
        {} as ExecutionContext
      );

      expect(fetchMock).not.toHaveBeenCalled();
      const row = await env.DB.prepare('SELECT location_label FROM users WHERE id = ?').bind('u1').first<any>();
      expect(row.location_label).toBe('My Hometown');
    });

    it('falls back to keeping the placeholder when the geocode call fails', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
      const cookie = await sessionCookieFor('u1');

      const res = await worker.fetch(
        new Request('http://localhost/api/onboarding', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            display_name: 'Jordan',
            date_of_birth: '1995-01-01',
            location_label: 'Current location',
            lat: 30.27,
            lng: -97.74,
            gender: 'female',
            seeking: 'male',
            intent: 'something_casual',
          }),
        }),
        env,
        {} as ExecutionContext
      );

      // Never blocks onboarding on a third-party outage.
      expect(res.status).toBe(200);
      const row = await env.DB.prepare('SELECT location_label FROM users WHERE id = ?').bind('u1').first<any>();
      expect(row.location_label).toBe('Current location');
    });
  });

  it('rejects and writes nothing when gender is missing or invalid', async () => {
    const cookie = await sessionCookieFor('u1');
    const post = (gender: unknown) =>
      worker.fetch(
        new Request('http://localhost/api/onboarding', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender, seeking: 'male', intent: 'something_casual' }),
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
      body: JSON.stringify({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'everyone', intent: 'something_casual' }),
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

  it('accepts seeking: friends -- a real filter value, not a fourth gender', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'friends', intent: 'something_casual' }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT gender, seeking FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.gender).toBe('male');
    expect(row.seeking).toBe('friends');
  });

  it('rejects the retired making_friends intent -- superseded by seeking: friends', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'female', intent: 'making_friends' }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_intent');
  });

  it('rejects the retired dating_around intent -- duplicated something_casual', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'female', intent: 'dating_around' }),
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
      intent: 'something_casual',
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

    await post({ display_name: 'Jordan', bio: 'loud guitars', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, max_distance_km: 25, gender: 'male', seeking: 'female', intent: 'something_casual' });

    const resaved = await post({ display_name: 'Jordan', bio: 'loud guitars', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, max_distance_km: 50, gender: 'male', seeking: 'female', intent: 'something_casual' });
    expect(resaved.status).toBe(200);

    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.bio).toBe('loud guitars');
    expect(row.max_distance_km).toBe(50);
  });

  it('locks gender after initial onboarding -- a later call attempting a different gender is silently ignored', async () => {
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

    await post({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'female', intent: 'something_casual' });

    // Settings → Preferences has no gender picker at all, but nothing stops
    // a hand-crafted request from trying anyway -- this is the actual
    // guarantee, not just the missing UI control.
    const resaved = await post({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'female', seeking: 'female', intent: 'something_casual' });
    expect(resaved.status).toBe(200);

    const row = await env.DB.prepare('SELECT gender FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.gender).toBe('male');
  });

  it('does not require gender at all on a post-onboarding save -- it is ignored either way', async () => {
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

    await post({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'female', intent: 'something_casual' });

    const resaved = await post({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, seeking: 'friends', intent: 'something_casual' });
    expect(resaved.status).toBe(200);

    const row = await env.DB.prepare('SELECT gender, seeking FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.gender).toBe('male');
    expect(row.seeking).toBe('friends');
  });

  it('does not even validate a malformed gender post-onboarding -- the field is wholly inert by then', async () => {
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

    await post({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'female', intent: 'something_casual' });

    const resaved = await post({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'nonbinary', seeking: 'female', intent: 'something_casual' });
    expect(resaved.status).toBe(200);

    const row = await env.DB.prepare('SELECT gender FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.gender).toBe('male');
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

    await post({ display_name: 'Jordan', bio: 'loud guitars', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'female', intent: 'something_casual' });
    await post({ display_name: 'Jordan', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, max_distance_km: 50, gender: 'male', seeking: 'female', intent: 'something_casual' });

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

  it('rejects and writes nothing when bio contains blocked language (issue: profile bio should be filtered like messages)', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Jordan', bio: 'this bio has a fucking slur in it', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_bio');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('accepts a display_name with letters, numbers, dashes, and spaces', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Jordan-Lee 2', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'female', intent: 'something_casual' }),
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
      body: JSON.stringify({ display_name: '  Jordan  ', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, gender: 'male', seeking: 'female', intent: 'something_casual' }),
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
      intent: 'something_casual',
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

  describe('invite code grant on first completion (migrations/0026)', () => {
    const completePayload = (overrides: Record<string, unknown>) => ({
      display_name: 'Jordan',
      date_of_birth: '1995-01-01',
      location_label: 'Austin, TX',
      gender: 'male',
      seeking: 'female',
      intent: 'something_casual',
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

    it('grants INVITE_CODES_PER_MEMBER codes targeting the opposite gender on first completion', async () => {
      const cookie = await sessionCookieFor('u1');
      const res = await post(cookie, completePayload({ gender: 'male' }));
      expect(res.status).toBe(200);

      const rows = await env.DB.prepare('SELECT target_gender, redeemed_by_user_id FROM invite_codes WHERE created_by_user_id = ?')
        .bind('u1')
        .all<any>();
      expect(rows.results.length).toBeGreaterThan(0);
      for (const row of rows.results) {
        expect(row.target_gender).toBe('female');
        expect(row.redeemed_by_user_id).toBeNull();
      }
    });

    it('does not grant a second batch on a later Settings re-save', async () => {
      const cookie = await sessionCookieFor('u1');
      await post(cookie, completePayload({}));
      const afterFirst = await env.DB.prepare('SELECT COUNT(*) c FROM invite_codes WHERE created_by_user_id = ?').bind('u1').first<any>();

      await post(cookie, completePayload({ display_name: 'Jordan Updated' }));
      const afterResave = await env.DB.prepare('SELECT COUNT(*) c FROM invite_codes WHERE created_by_user_id = ?').bind('u1').first<any>();

      expect(afterResave.c).toBe(afterFirst.c);
    });
  });
});
