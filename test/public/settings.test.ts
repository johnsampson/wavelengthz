import { describe, it, expect, vi } from 'vitest';
import { createSettingsApp } from '../../public/settings.js';

function stubApi(user: Record<string, unknown>, photos: Array<Record<string, unknown>> = []) {
  const calls: Array<{ path: string; options: any }> = [];
  const fetchMock = vi.fn(async (path: string, options: any = {}) => {
    calls.push({ path, options });
    if (path === '/api/me') return new Response(JSON.stringify({ user }), { status: 200 });
    if (path === '/api/photos' && (!options.method || options.method === 'GET')) {
      return new Response(JSON.stringify({ photos }), { status: 200 });
    }
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
  gender: 'male',
  seeking: 'female',
  intent: 'dating_around',
  spotify_avatar_url: 'https://img.example/avatar.jpg',
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
    expect(app.spotifyAvatarUrl).toBe('https://img.example/avatar.jpg');
    vi.unstubAllGlobals();
  });

  it('leaves the avatar null when the account has none', async () => {
    stubApi({ ...ONBOARDED_USER, spotify_avatar_url: null });
    const app = createSettingsApp();

    await app.init();

    expect(app.spotifyAvatarUrl).toBeNull();
    vi.unstubAllGlobals();
  });

  it('round-trips a still-valid intent unchanged', async () => {
    stubApi(ONBOARDED_USER); // intent: 'dating_around'
    const app = createSettingsApp();

    await app.init();

    expect(app.intent).toBe('dating_around');
    vi.unstubAllGlobals();
  });

  it('resets a retired intent value to unset instead of keeping it stale', async () => {
    // 'making_friends' was retired from INTENT_OPTIONS (superseded by the
    // real seeking:'friends' filter) -- a user who set it before that no
    // longer has a matching button. Silently keeping the stale value would
    // get their next Save rejected by POST /api/onboarding's INTENT_OPTIONS
    // check, with no visible button to explain why.
    stubApi({ ...ONBOARDED_USER, intent: 'making_friends' });
    const app = createSettingsApp();

    await app.init();

    expect(app.intent).toBe('');
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

  it('loads the existing display name and lets it be changed', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    await app.init();
    expect(app.displayName).toBe('Jordan');

    app.displayName = 'Jordan Two';
    await app.updateDistance();

    const body = api.onboardBody();
    expect(body.display_name).toBe('Jordan Two');
    expect(app.saved).toBe(true);
  });

  it('loads the caller\'s own id so a preview-profile link can use it', async () => {
    stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    expect(app.userId).toBeNull();

    await app.init();

    expect(app.userId).toBe('u1');
    vi.unstubAllGlobals();
  });

  it('rejects saving a blank display name without a network call', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    await app.init();

    app.displayName = '   ';
    await app.updateDistance();

    expect(app.error).toBeTruthy();
    expect(app.saved).toBe(false);
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
  });

  it('rejects saving a display name with disallowed characters without a network call', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    await app.init();

    app.displayName = 'Jordan!!';
    await app.updateDistance();

    expect(app.error).toBeTruthy();
    expect(app.saved).toBe(false);
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
  });

  it('loads gender, seeking, and intent on init and round-trips them on save', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    await app.init();

    expect(app.gender).toBe('male');
    expect(app.seeking).toBe('female');
    expect(app.intent).toBe('dating_around');

    await app.updateDistance();
    const body = api.onboardBody();
    expect(body.gender).toBe('male');
    expect(body.seeking).toBe('female');
    expect(body.intent).toBe('dating_around');
    vi.unstubAllGlobals();
  });

  it('rejects saving without a gender selected', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    await app.init();
    app.gender = '';

    await app.updateDistance();

    expect(app.error).toBeTruthy();
    expect(app.saved).toBe(false);
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects saving without seeking selected', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    await app.init();
    app.seeking = '';

    await app.updateDistance();

    expect(app.error).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects saving without intent selected', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    await app.init();
    app.intent = '';

    await app.updateDistance();

    expect(app.error).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('has no cooldown when location_updated_at is null', async () => {
    stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    await app.init();

    expect(app.locationCooldownRemainingMs).toBe(0);
    vi.unstubAllGlobals();
  });

  it('reports the remaining cooldown when location was changed recently', async () => {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    stubApi({ ...ONBOARDED_USER, location_updated_at: threeDaysAgo });
    const app = createSettingsApp();
    await app.init();

    expect(app.locationCooldownRemainingMs).toBeGreaterThan(0);
    expect(app.locationCooldownRemainingDays).toBe(4);
    vi.unstubAllGlobals();
  });

  it('shows a friendly cooldown message when the server rejects a location change', async () => {
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/photos') return new Response(JSON.stringify({ photos: [] }), { status: 200 });
      if (path === '/api/onboarding') {
        return new Response(JSON.stringify({ error: 'location_change_cooldown', retryAfterMs: 2 * 24 * 60 * 60 * 1000 }), { status: 429 });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createSettingsApp();
    await app.init();

    await app.updateDistance();

    expect(app.error).toContain('7 days');
    expect(app.error).toContain('2 days');
    expect(app.saved).toBe(false);
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

  it('redirects to /login instead of showing an error when /api/me is unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createSettingsApp();

    await app.init();

    expect(fakeWindow.location.href).toBe('/login');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('logs out and lands on the deck (not /login, which would silently re-trigger Spotify OAuth)', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/logout') return new Response('ok', { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createSettingsApp();

    await app.logout();

    expect(fetchMock).toHaveBeenCalledWith('/logout', expect.objectContaining({ method: 'POST' }));
    expect(fakeWindow.location.href).toBe('/');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('loads existing photos on init', async () => {
    stubApi(ONBOARDED_USER, [{ photoId: 'p1', url: '/photos/p1', position: 0 }]);
    const app = createSettingsApp();

    await app.init();

    expect(app.photos).toEqual([{ photoId: 'p1', url: '/photos/p1', position: 0 }]);
  });

  it('uploads a photo and appends it to the list', async () => {
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/photos' && (!options.method || options.method === 'GET')) {
        return new Response(JSON.stringify({ photos: [] }), { status: 200 });
      }
      if (path === '/api/photos' && options.method === 'POST') {
        return new Response(JSON.stringify({ photoId: 'p2', url: '/photos/p2' }), { status: 200 });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createSettingsApp();
    await app.init();

    await app.uploadPhoto({ target: { files: [{ type: 'image/jpeg', size: 1000 }], value: '' } });

    expect(app.photos).toEqual([{ photoId: 'p2', url: '/photos/p2' }]);
    expect(app.photoError).toBeNull();
    vi.unstubAllGlobals();
  });

  it('refuses to upload past the 10-photo cap without a network call', async () => {
    const photos = Array.from({ length: 10 }, (_, i) => ({ photoId: `p${i}`, url: `/photos/p${i}`, position: i }));
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/photos' && (!options.method || options.method === 'GET')) {
        return new Response(JSON.stringify({ photos }), { status: 200 });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createSettingsApp();
    await app.init();

    await app.uploadPhoto({ target: { files: [{ type: 'image/jpeg', size: 1000 }], value: '' } });

    expect(app.photos).toHaveLength(10);
    expect(app.photoError).toContain('10');
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/photos' && c[1]?.method === 'POST')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('removes a photo from the list', async () => {
    const api = stubApi(ONBOARDED_USER, [
      { photoId: 'p1', url: '/photos/p1', position: 0 },
      { photoId: 'p2', url: '/photos/p2', position: 1 },
    ]);
    const app = createSettingsApp();
    await app.init();

    await app.removePhoto('p1');

    expect(app.photos.map((p: any) => p.photoId)).toEqual(['p2']);
    expect(api.calls.some((c) => c.path === '/api/photos/p1' && c.options.method === 'DELETE')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('surfaces an error and does not redirect when the logout request fails', async () => {
    // Regression: fetch() only rejects on a true network failure, not on a
    // non-2xx response, so a failed /logout was silently treated as success
    // and the client redirected anyway -- masking a session that never
    // actually got cleared server-side.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createSettingsApp();

    await app.logout();

    expect(fakeWindow.location.href).toBe('');
    expect(app.error).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('loads the real age range instead of leaving the hardcoded 18-100 default', async () => {
    stubApi({ ...ONBOARDED_USER, age_min: 25, age_max: 40 });
    const app = createSettingsApp();
    expect(app.ageMin).toBe(18); // placeholder before init
    expect(app.ageMax).toBe(100);

    await app.init();

    expect(app.ageMin).toBe(25);
    expect(app.ageMax).toBe(40);
    vi.unstubAllGlobals();
  });

  it('round-trips a changed age range on save', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    await app.init();
    app.ageMin = 22;
    app.ageMax = 55;

    await app.updateDistance();

    const body = api.onboardBody();
    expect(body.age_min).toBe(22);
    expect(body.age_max).toBe(55);
    vi.unstubAllGlobals();
  });

  it('shows "100+" in the range label when the max is uncapped', async () => {
    stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
    await app.init();

    expect(app.ageRangeLabel).toBe('18 - 100+');
    vi.unstubAllGlobals();
  });

  it('clamps the minimum thumb so it can never cross the maximum', async () => {
    stubApi(ONBOARDED_USER);
    const app = createSettingsApp();
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
    const app = createSettingsApp();
    await app.init();
    app.ageMin = 40;

    app.ageMax = 40;
    app.handleAgeMaxInput();

    expect(app.ageMax).toBe(41);
    expect(app.activeAgeThumb).toBe('max');
    vi.unstubAllGlobals();
  });
});
