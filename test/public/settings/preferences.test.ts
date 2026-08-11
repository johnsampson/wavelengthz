import { describe, it, expect, vi } from 'vitest';
import { createPreferencesApp } from '../../../public/settings/preferences.js';

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
  display_name: 'Jordan',
  bio: 'I like loud guitars',
  date_of_birth: '1995-01-01',
  location_label: 'Austin, TX',
  lat: 30.27,
  lng: -97.74,
  location_updated_at: null,
  max_distance_km: 25,
  age_min: 25,
  age_max: 40,
  gender: 'male',
  seeking: 'female',
  intent: 'something_casual',
};

describe('preferences page', () => {
  it('loads the real max_distance_km instead of leaving the hardcoded default', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    expect(app.maxDistanceKm).toBe(80); // placeholder before init

    await app.init();

    expect(app.maxDistanceKm).toBe(25);
    expect(app.loading).toBe(false);
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('loads the real age range instead of leaving the hardcoded 18-100 default', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    expect(app.ageMin).toBe(18);
    expect(app.ageMax).toBe(100);

    await app.init();

    expect(app.ageMin).toBe(25);
    expect(app.ageMax).toBe(40);
    vi.unstubAllGlobals();
  });

  it('round-trips a still-valid intent unchanged', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();

    await app.init();

    expect(app.intent).toBe('something_casual');
    vi.unstubAllGlobals();
  });

  it('resets a retired intent value to unset instead of keeping it stale', async () => {
    stubApi({ ...ONBOARDED_USER, intent: 'making_friends' });
    const app = createPreferencesApp();

    await app.init();

    expect(app.intent).toBe('');
    vi.unstubAllGlobals();
  });

  it('resets the retired dating_around intent to unset too, not just making_friends', async () => {
    stubApi({ ...ONBOARDED_USER, intent: 'dating_around' });
    const app = createPreferencesApp();

    await app.init();

    expect(app.intent).toBe('');
    vi.unstubAllGlobals();
  });

  it('loads gender and seeking on init', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();

    await app.init();

    expect(app.gender).toBe('male');
    expect(app.seeking).toBe('female');
    vi.unstubAllGlobals();
  });

  it('rejects saving without a gender selected', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();
    app.gender = '';

    await app.save();

    expect(app.error).toBeTruthy();
    expect(app.saved).toBe(false);
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects saving without seeking selected', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();
    app.seeking = '';

    await app.save();

    expect(app.error).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects saving without intent selected', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();
    app.intent = '';

    await app.save();

    expect(app.error).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('saves edited preferences and echoes back display_name/bio/date_of_birth unedited', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();
    app.maxDistanceKm = 50;
    app.ageMin = 22;
    app.ageMax = 55;

    await app.save();

    const body = api.onboardBody();
    expect(body.max_distance_km).toBe(50);
    expect(body.age_min).toBe(22);
    expect(body.age_max).toBe(55);
    expect(body.gender).toBe('male');
    expect(body.seeking).toBe('female');
    expect(body.intent).toBe('something_casual');
    // Profile's fields, echoed back unedited:
    expect(body.display_name).toBe('Jordan');
    expect(body.bio).toBe('I like loud guitars');
    expect(body.date_of_birth).toBe('1995-01-01');
    expect(app.saved).toBe(true);
    vi.unstubAllGlobals();
  });

  it('sends bio: null rather than undefined for a user who never wrote one', async () => {
    const api = stubApi({ ...ONBOARDED_USER, bio: null });
    const app = createPreferencesApp();
    await app.init();

    await app.save();

    const body = api.onboardBody();
    expect('bio' in body).toBe(true);
    expect(body.bio).toBeNull();
    vi.unstubAllGlobals();
  });

  it('has no cooldown when location_updated_at is null', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();

    expect(app.locationCooldownRemainingMs).toBe(0);
    vi.unstubAllGlobals();
  });

  it('reports the remaining cooldown when location was changed recently', async () => {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    stubApi({ ...ONBOARDED_USER, location_updated_at: threeDaysAgo });
    const app = createPreferencesApp();
    await app.init();

    expect(app.locationCooldownRemainingMs).toBeGreaterThan(0);
    expect(app.locationCooldownRemainingDays).toBe(4);
    vi.unstubAllGlobals();
  });

  it('shows a friendly cooldown message when the server rejects a location change', async () => {
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/onboarding') {
        return new Response(JSON.stringify({ error: 'location_change_cooldown', retryAfterMs: 2 * 24 * 60 * 60 * 1000 }), { status: 429 });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createPreferencesApp();
    await app.init();

    await app.save();

    expect(app.error).toContain('7 days');
    expect(app.error).toContain('2 days');
    expect(app.saved).toBe(false);
    vi.unstubAllGlobals();
  });

  it('shows "100+" in the range label when the max is uncapped', async () => {
    const app = createPreferencesApp();

    expect(app.ageRangeLabel).toBe('18 - 100+');
  });

  it('clamps the minimum thumb so it can never cross the maximum', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();
    app.ageMax = 30;

    app.ageMin = 30;
    app.handleAgeMinInput();

    expect(app.ageMin).toBe(29);
    expect(app.activeAgeThumb).toBe('min');
    vi.unstubAllGlobals();
  });

  it('clamps the maximum thumb so it can never cross the minimum', async () => {
    stubApi(ONBOARDED_USER);
    const app = createPreferencesApp();
    await app.init();
    app.ageMin = 40;

    app.ageMax = 40;
    app.handleAgeMaxInput();

    expect(app.ageMax).toBe(41);
    expect(app.activeAgeThumb).toBe('max');
    vi.unstubAllGlobals();
  });

  it('surfaces an error and stops loading when /api/me fails on init', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createPreferencesApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('redirects to /login instead of showing an error when /api/me is unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createPreferencesApp();

    await app.init();

    expect(fakeWindow.location.href).toBe('/login');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });
});
