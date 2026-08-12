import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProfileApp } from '../../../public/settings/profile.js';
import { showErrorToast } from '../../../public/toast.js';

vi.mock('../../../public/toast.js', () => ({ showErrorToast: vi.fn() }));

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
});

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
  max_distance_km: 25,
  age_min: 25,
  age_max: 40,
  gender: 'male',
  seeking: 'female',
  intent: 'something_casual',
};

describe('profile page', () => {
  it('loads the existing display name', async () => {
    stubApi(ONBOARDED_USER);
    const app = createProfileApp();

    await app.init();

    expect(app.displayName).toBe('Jordan');
    expect(app.loading).toBe(false);
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('loads the existing bio', async () => {
    stubApi(ONBOARDED_USER);
    const app = createProfileApp();

    await app.init();

    expect(app.bio).toBe('I like loud guitars');
    vi.unstubAllGlobals();
  });

  it('loads existing photos on init', async () => {
    stubApi(ONBOARDED_USER, [{ photoId: 'p1', url: '/photos/p1', position: 0 }]);
    const app = createProfileApp();

    await app.init();

    expect(app.photos).toEqual([{ photoId: 'p1', url: '/photos/p1', position: 0 }]);
    vi.unstubAllGlobals();
  });

  it('rejects saving a blank display name without a network call', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createProfileApp();
    await app.init();

    app.displayName = '   ';
    await app.save();

    expect(showErrorToast).toHaveBeenCalled();
    expect(app.saved).toBe(false);
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects saving a display name with disallowed characters without a network call', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createProfileApp();
    await app.init();

    app.displayName = 'Jordan!!';
    await app.save();

    expect(showErrorToast).toHaveBeenCalled();
    expect(api.calls.some((c) => c.path === '/api/onboarding')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('saves the trimmed display name and echoes back every field POST /api/onboarding owns, including the other page\'s fields', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createProfileApp();
    await app.init();
    app.displayName = '  Jordan Two  ';

    await app.save();

    const body = api.onboardBody();
    expect(body.display_name).toBe('Jordan Two');
    // Fields this page never shows, echoed back unedited so Preferences'
    // values aren't clobbered by this page's save:
    expect(body.bio).toBe('I like loud guitars');
    expect(body.date_of_birth).toBe('1995-01-01');
    expect(body.location_label).toBe('Austin, TX');
    expect(body.lat).toBe(30.27);
    expect(body.lng).toBe(-97.74);
    expect(body.max_distance_km).toBe(25);
    expect(body.age_min).toBe(25);
    expect(body.age_max).toBe(40);
    expect(body.gender).toBe('male');
    expect(body.seeking).toBe('female');
    expect(body.intent).toBe('something_casual');
    expect(app.displayName).toBe('Jordan Two');
    expect(app.saved).toBe(true);
    vi.unstubAllGlobals();
  });

  it('saves an edited, trimmed bio', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createProfileApp();
    await app.init();
    app.bio = '  Loud guitars and quiet mornings  ';

    await app.save();

    const body = api.onboardBody();
    expect(body.bio).toBe('Loud guitars and quiet mornings');
    expect(app.bio).toBe('Loud guitars and quiet mornings');
    expect(app.saved).toBe(true);
    vi.unstubAllGlobals();
  });

  it('sends null when the bio is cleared, rather than an empty string', async () => {
    const api = stubApi(ONBOARDED_USER);
    const app = createProfileApp();
    await app.init();
    app.bio = '   ';

    await app.save();

    const body = api.onboardBody();
    expect(body.bio).toBeNull();
    vi.unstubAllGlobals();
  });

  it('surfaces a specific error when the bio is rejected as too long or containing blocked language', async () => {
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/photos' && (!options.method || options.method === 'GET')) {
        return new Response(JSON.stringify({ photos: [] }), { status: 200 });
      }
      if (path === '/api/onboarding') {
        return new Response(JSON.stringify({ error: 'invalid_bio' }), { status: 400 });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createProfileApp();
    await app.init();
    app.bio = 'whatever triggers the filter';

    await app.save();

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('bio'));
    expect(app.saved).toBe(false);
    vi.unstubAllGlobals();
  });

  it('surfaces a specific, actionable error when saving fails because the account has a retired intent value', async () => {
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/onboarding') {
        return new Response(JSON.stringify({ error: 'invalid_intent' }), { status: 400 });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createProfileApp();
    await app.init();
    app.displayName = 'Jordan Two';

    await app.save();

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('Preferences'));
    expect(app.saved).toBe(false);
    vi.unstubAllGlobals();
  });

  it('surfaces an error and stops loading when /api/me fails on init', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createProfileApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('redirects to /login instead of showing an error when /api/me is unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createProfileApp();

    await app.init();

    expect(fakeWindow.location.href).toBe('/login');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
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
    const app = createProfileApp();
    await app.init();

    await app.uploadPhoto({ target: { files: [{ type: 'image/jpeg', size: 1000 }], value: '' } });

    expect(app.photos).toEqual([{ photoId: 'p2', url: '/photos/p2' }]);
    expect(showErrorToast).not.toHaveBeenCalled();
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
    const app = createProfileApp();
    await app.init();

    await app.uploadPhoto({ target: { files: [{ type: 'image/jpeg', size: 1000 }], value: '' } });

    expect(app.photos).toHaveLength(10);
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('10'));
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/photos' && c[1]?.method === 'POST')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('growls an error toast when the upload itself fails (not just the cap check)', async () => {
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/photos' && (!options.method || options.method === 'GET')) {
        return new Response(JSON.stringify({ photos: [] }), { status: 200 });
      }
      if (path === '/api/photos' && options.method === 'POST') return new Response('nope', { status: 500 });
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createProfileApp();
    await app.init();

    await app.uploadPhoto({ target: { files: [{ type: 'image/jpeg', size: 1000 }], value: '' } });

    expect(app.photos).toHaveLength(0);
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('upload'));
    vi.unstubAllGlobals();
  });

  it('removes a photo from the list', async () => {
    const api = stubApi(ONBOARDED_USER, [
      { photoId: 'p1', url: '/photos/p1', position: 0 },
      { photoId: 'p2', url: '/photos/p2', position: 1 },
    ]);
    const app = createProfileApp();
    await app.init();

    await app.removePhoto('p1');

    expect(app.photos.map((p: any) => p.photoId)).toEqual(['p2']);
    expect(api.calls.some((c) => c.path === '/api/photos/p1' && c.options.method === 'DELETE')).toBe(true);
    expect(showErrorToast).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('growls an error toast and keeps the photo when removal fails', async () => {
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/photos' && (!options.method || options.method === 'GET')) {
        return new Response(JSON.stringify({ photos: [{ photoId: 'p1', url: '/photos/p1', position: 0 }] }), { status: 200 });
      }
      if (path === '/api/photos/p1' && options.method === 'DELETE') return new Response('nope', { status: 500 });
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createProfileApp();
    await app.init();

    await app.removePhoto('p1');

    expect(app.photos).toHaveLength(1);
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('remove'));
    vi.unstubAllGlobals();
  });

  it('deletes the account and redirects to the deck', async () => {
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/photos') return new Response(JSON.stringify({ photos: [] }), { status: 200 });
      if (path === '/api/account' && options.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createProfileApp();
    await app.init();

    await app.deleteAccount();

    expect(fakeWindow.location.href).toBe('/');
    expect(showErrorToast).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('growls an error toast and does not redirect when account deletion fails', async () => {
    const fetchMock = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: ONBOARDED_USER }), { status: 200 });
      if (path === '/api/photos') return new Response(JSON.stringify({ photos: [] }), { status: 200 });
      if (path === '/api/account' && options.method === 'DELETE') return new Response('nope', { status: 500 });
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createProfileApp();
    await app.init();

    await app.deleteAccount();

    expect(fakeWindow.location.href).toBe('');
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('delete'));
    vi.unstubAllGlobals();
  });
});
