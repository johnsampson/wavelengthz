import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConnectionsApp } from '../../../public/settings/connections.js';
import { showErrorToast } from '../../../public/toast.js';

vi.mock('../../../public/toast.js', () => ({ showErrorToast: vi.fn() }));

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
});

const OFF_SYNC = { enabled: false, connected: false, playlistUrl: null, lastSyncedAt: null, pendingCount: 0, syncedCount: 0 };

function stubApi(user: Record<string, unknown>, sync: Record<string, unknown> = OFF_SYNC) {
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/api/me') return new Response(JSON.stringify({ user, hasSpotify: user.hasSpotify ?? false }), { status: 200 });
    if (path === '/api/me/playlist-sync') return new Response(JSON.stringify(sync), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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

  it('does not ask for sync status at all when no Spotify account is linked', async () => {
    const fetchMock = stubApi({ id: 'u1', hasSpotify: false });
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await app.init();

    expect(fetchMock).not.toHaveBeenCalledWith('/api/me/playlist-sync', expect.anything());
    expect(app.sync).toBeNull();
    vi.unstubAllGlobals();
  });

  it('loads sync status when Spotify is linked', async () => {
    stubApi({ id: 'u1', hasSpotify: true }, { ...OFF_SYNC, enabled: true, connected: true, pendingCount: 7 });
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await app.init();

    expect(app.sync!.enabled).toBe(true);
    expect(app.sync!.pendingCount).toBe(7);
    vi.unstubAllGlobals();
  });

  it('sends the user through a real consent round trip to enable, rather than posting', async () => {
    // The write scope cannot be added to an existing token, so there is no
    // endpoint that could turn this on -- only the OAuth callback can.
    const fetchMock = stubApi({ id: 'u1', hasSpotify: true });
    const fakeWindow = { location: { href: '', search: '' }, history: { replaceState: () => {} } };
    vi.stubGlobal('window', fakeWindow);
    const app = createConnectionsApp();

    app.enableSync();

    expect(fakeWindow.location.href).toBe('/login/spotify?intent=sync');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('confirms sync is on after returning from a successful consent trip', async () => {
    stubApi({ id: 'u1', hasSpotify: true }, { ...OFF_SYNC, enabled: true, connected: true });
    const fakeWindow = { location: { search: '?sync_enabled=1' }, history: { replaceState: vi.fn() } };
    vi.stubGlobal('window', fakeWindow);
    const app = createConnectionsApp();

    await app.init();

    expect(app.info).toContain('Playlist sync is on');
    expect(fakeWindow.history.replaceState).toHaveBeenCalledWith({}, '', '/settings/connections');
    vi.unstubAllGlobals();
  });

  it('says plainly that nothing changed when consent was declined', async () => {
    stubApi({ id: 'u1', hasSpotify: true });
    const fakeWindow = { location: { search: '?sync_error=denied' }, history: { replaceState: vi.fn() } };
    vi.stubGlobal('window', fakeWindow);
    const app = createConnectionsApp();

    await app.init();

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('Nothing was changed'));
    vi.unstubAllGlobals();
  });

  it('reports how many songs were added, and that more are coming when capped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ added: 300, hasMore: true, status: { ...OFF_SYNC, enabled: true, connected: true, pendingCount: 25 } }),
      { status: 200 }
    )));
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await app.syncNow();

    expect(app.info).toContain('300');
    expect(app.info).toContain('rest will follow');
    expect(app.sync!.pendingCount).toBe(25);
    expect(app.syncing).toBe(false);
    vi.unstubAllGlobals();
  });

  it('says the playlist is already up to date when there was nothing to add', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ added: 0, status: { ...OFF_SYNC, enabled: true, connected: true } }),
      { status: 200 }
    )));
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await app.syncNow();

    expect(app.info).toContain('already up to date');
    vi.unstubAllGlobals();
  });

  it('points at reconnecting when Spotify has revoked write access', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ added: 0, needsReconnect: true, status: OFF_SYNC }),
      { status: 200 }
    )));
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await app.syncNow();

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('revoked'));
    vi.unstubAllGlobals();
  });

  it('ignores a second Sync now tap while one is already running', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ added: 0, status: OFF_SYNC }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await Promise.all([app.syncNow(), app.syncNow()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('makes clear that turning sync off leaves existing songs alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ...OFF_SYNC, connected: true, syncedCount: 12 }),
      { status: 200 }
    )));
    vi.stubGlobal('window', { location: { search: '' }, history: { replaceState: () => {} } });
    const app = createConnectionsApp();

    await app.disableSync();

    expect(app.sync!.enabled).toBe(false);
    expect(app.info).toContain('stay there');
    vi.unstubAllGlobals();
  });
});
