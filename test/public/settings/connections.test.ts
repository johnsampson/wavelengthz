import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConnectionsApp } from '../../../public/settings/connections.js';
import { showErrorToast } from '../../../public/toast.js';

vi.mock('../../../public/toast.js', () => ({ showErrorToast: vi.fn() }));

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
});

function stubApi(user: Record<string, unknown>) {
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/api/me') return new Response(JSON.stringify({ user, hasSpotify: user.hasSpotify ?? false }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('connections page', () => {
  it('loads hasSpotify and the avatar url', async () => {
    stubApi({ id: 'u1', spotify_avatar_url: 'https://img.example/avatar.jpg', hasSpotify: true });
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await app.init();

    expect(app.hasSpotify).toBe(true);
    expect(app.spotifyAvatarUrl).toBe('https://img.example/avatar.jpg');
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('leaves the avatar null when the account has none', async () => {
    stubApi({ id: 'u1', spotify_avatar_url: null, hasSpotify: false });
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await app.init();

    expect(app.spotifyAvatarUrl).toBeNull();
    expect(app.hasSpotify).toBe(false);
    vi.unstubAllGlobals();
  });

  it('shows a confirmation message and strips the query string after a successful connect', async () => {
    stubApi({ id: 'u1', hasSpotify: true });
    const fakeWindow = { location: { search: '?spotify_connected=1' }, history: { replaceState: vi.fn() } };
    vi.stubGlobal('window', fakeWindow);
    const app = createConnectionsApp();

    await app.init();

    expect(app.info).toBe('Spotify connected.');
    expect(fakeWindow.history.replaceState).toHaveBeenCalledWith({}, '', '/settings/connections');
    vi.unstubAllGlobals();
  });

  it('growls an already-linked error toast and strips the query string after a failed connect', async () => {
    stubApi({ id: 'u1', hasSpotify: false });
    const fakeWindow = { location: { search: '?spotify_error=already_linked' }, history: { replaceState: vi.fn() } };
    vi.stubGlobal('window', fakeWindow);
    const app = createConnectionsApp();

    await app.init();

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('already linked'));
    expect(fakeWindow.history.replaceState).toHaveBeenCalledWith({}, '', '/settings/connections');
    vi.unstubAllGlobals();
  });

  it('surfaces an error and stops loading when /api/me fails on init', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('redirects to /login instead of showing an error when /api/me is unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const fakeWindow = { location: { href: '', search: '' }, history: { replaceState: () => {} } };
    vi.stubGlobal('window', fakeWindow);
    const app = createConnectionsApp();

    await app.init();

    expect(fakeWindow.location.href).toBe('/login');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });
});
