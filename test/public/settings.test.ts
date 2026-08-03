import { describe, it, expect, vi } from 'vitest';
import { createSettingsApp } from '../../public/settings.js';

function stubApi(user: Record<string, unknown>) {
  const calls: Array<{ path: string; options: any }> = [];
  const fetchMock = vi.fn(async (path: string, options: any = {}) => {
    calls.push({ path, options });
    if (path === '/api/me') return new Response(JSON.stringify({ user }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    onboardBody: () => JSON.parse(calls.find((c) => c.path === '/api/onboarding')!.options.body),
  };
}

const ONBOARDED_USER = {
  id: 'u1',
  bio: 'I like loud guitars',
  date_of_birth: '1995-01-01',
  location_label: 'Austin, TX',
  lat: 30.27,
  lng: -97.74,
  max_distance_km: 25,
};

describe('settings page', () => {
  it('loads the real max_distance_km instead of leaving the hardcoded default', async () => {
    // Regression: the page hardcoded maxDistanceKm = 80 on load, so simply
    // opening Settings and hitting Save silently reset a user who had chosen
    // 25km back to 80km.
    stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    expect(app.maxDistanceKm).toBe(80); // placeholder before init

    await app.init();

    expect(app.maxDistanceKm).toBe(25);
    expect(app.loading).toBe(false);
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('round-trips the existing bio when saving the distance', async () => {
    // Regression: POST /api/onboarding does an unconditional `SET bio = ?`
    // bound to `body.bio ?? null`. Settings reuses that endpoint, so omitting
    // bio from the payload wiped the user's bio to NULL on every save.
    const api = stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    await app.init();
    app.maxDistanceKm = 50;

    await app.updateDistance();

    const body = api.onboardBody();
    expect(body.bio).toBe('I like loud guitars');
    expect(body.max_distance_km).toBe(50);
    expect(body.date_of_birth).toBe('1995-01-01');
    expect(body.location_label).toBe('Austin, TX');
    expect(app.saved).toBe(true);
    vi.unstubAllGlobals();
  });

  it('sends bio: null rather than undefined for a user who never wrote one', async () => {
    // `undefined` would be dropped by JSON.stringify, leaving the field absent
    // -- which is exactly the shape that caused the wipe. Assert it is present
    // and explicitly null.
    const api = stubApi({ ...ONBOARDED_USER, bio: null });
    const app = createSettingsApp();
    await app.init();

    await app.updateDistance();

    const body = api.onboardBody();
    expect('bio' in body).toBe(true);
    expect(body.bio).toBeNull();
    vi.unstubAllGlobals();
  });

  it('surfaces an error and stops loading when /api/me fails on init', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createSettingsApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });
});
