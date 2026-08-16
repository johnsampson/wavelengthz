import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createArtistApp } from '../../public/artist.js';
import { showErrorToast } from '../../public/toast.js';
import { play, togglePlayPause, isCurrentTrack } from '../../public/playerBar.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));
vi.mock('../../public/playerBar.js', () => ({
  play: vi.fn(),
  togglePlayPause: vi.fn(),
  isCurrentTrack: vi.fn(() => false),
}));

function fakeWindow() {
  return { location: { search: '?id=a1', href: '' } };
}

function stubApi(handler: (path: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => handler(path)));
}

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
  vi.mocked(play).mockClear();
  vi.mocked(togglePlayPause).mockClear();
  vi.mocked(isCurrentTrack).mockReset().mockReturnValue(false);
});

describe('artist page', () => {
  it('loads the artist and tracks on init', async () => {
    vi.stubGlobal('window', fakeWindow());
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path.startsWith('/api/artists/a1'))
        return new Response(JSON.stringify({ artist: { id: 'a1', name: 'Test Artist' }, tracks: [{ id: 't1' }], hasMore: true }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createArtistApp();

    await app.init();

    expect(app.artist?.name).toBe('Test Artist');
    expect(app.tracks).toEqual([{ id: 't1' }]);
    expect(app.hasMoreTracks).toBe(true);
    vi.unstubAllGlobals();
  });

  it('shows a rate-limit-specific error message', async () => {
    vi.stubGlobal('window', fakeWindow());
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      return new Response(JSON.stringify({ error: 'spotify_rate_limited' }), { status: 503 });
    });
    const app = createArtistApp();

    await app.init();

    expect(app.error).toContain('busy');
    vi.unstubAllGlobals();
  });

  it('loadMoreTracks fetches at a higher limit and replaces the list', async () => {
    vi.stubGlobal('window', fakeWindow());
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/artists/a1?limit=60') return new Response(JSON.stringify({ tracks: [{ id: 't1' }, { id: 't2' }], hasMore: false }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createArtistApp();
    app.hasMoreTracks = true;

    await app.loadMoreTracks();

    expect(fetchMock).toHaveBeenCalledWith('/api/artists/a1?limit=60', expect.anything());
    expect(app.tracks).toEqual([{ id: 't1' }, { id: 't2' }]);
    expect(app.hasMoreTracks).toBe(false);
    expect(app.loadingMore).toBe(false);
    vi.unstubAllGlobals();
  });

  it('togglePlayer toggles pause on the currently-playing track instead of restarting it', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.mocked(isCurrentTrack).mockReturnValue(true);
    const app = createArtistApp();

    await app.togglePlayer({ spotifyId: 'sp1', name: 'Song', imageUrl: 'img' });

    expect(togglePlayPause).toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('togglePlayer hands off a new track to the player bar, tagged with this page\'s one artist name', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.mocked(isCurrentTrack).mockReturnValue(false);
    const app = createArtistApp();
    app.artist = { id: 'a1', name: 'Test Artist', genres: [], totalLikes: 0, totalLikesInArea: 0, direction: null };

    await app.togglePlayer({ id: 't1', spotifyId: 'sp1', name: 'Song', imageUrl: 'img' });

    expect(play).toHaveBeenCalledWith({ spotifyId: 'sp1', id: 't1', name: 'Song', artistName: 'Test Artist', imageUrl: 'img' });
    vi.unstubAllGlobals();
  });

  it('optimistically sets swipe direction and rolls back on failure', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createArtistApp();
    const track = { id: 't1', direction: null };

    await app.swipeTrack(track, 'right');

    expect(track.direction).toBeNull();
    expect(showErrorToast).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('likeArtist optimistically marks the artist liked and posts an artist-level right swipe', async () => {
    vi.stubGlobal('window', fakeWindow());
    const fetchMock = vi.fn(async (path: string, options: any) => {
      if (path === '/api/swipe/music') {
        expect(JSON.parse(options.body)).toEqual({ item_type: 'artist', item_id: 'a1', direction: 'right' });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createArtistApp();
    app.artist = { id: 'a1', name: 'Test Artist', genres: [], totalLikes: 0, totalLikesInArea: 0, direction: null };

    await app.likeArtist();

    expect(app.artist.direction).toBe('right');
    expect(fetchMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('likeArtist rolls back the optimistic update on failure', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createArtistApp();
    app.artist = { id: 'a1', name: 'Test Artist', genres: [], totalLikes: 0, totalLikesInArea: 0, direction: null };

    await app.likeArtist();

    expect(app.artist.direction).toBeNull();
    expect(showErrorToast).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('likeArtist is a no-op when the artist is already liked', async () => {
    vi.stubGlobal('window', fakeWindow());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const app = createArtistApp();
    app.artist = { id: 'a1', name: 'Test Artist', genres: [], totalLikes: 1, totalLikesInArea: 0, direction: 'right' };

    await app.likeArtist();

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
