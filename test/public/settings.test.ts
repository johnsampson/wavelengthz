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
  bio: 'I like loud guitars',
  date_of_birth: '1995-01-01',
  location_label: 'Austin, TX',
  lat: 30.27,
  lng: -97.74,
  max_distance_km: 25,
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
});
