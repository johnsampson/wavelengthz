import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTrackPicker } from '../../public/trackPicker.js';
import { showErrorToast } from '../../public/toast.js';
import { play, togglePlayPause, isCurrentTrack } from '../../public/playerBar.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));
vi.mock('../../public/playerBar.js', () => ({
  play: vi.fn(),
  togglePlayPause: vi.fn(),
  isCurrentTrack: vi.fn(() => false),
}));

function stubApi(handler: (path: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => handler(path)));
}

/**
 * Builds a picker with the host-app bits its methods lean on ($nextTick,
 * $refs, load, scrollToBottom) faked out -- the same shape messages.js and
 * group.js actually spread it into.
 */
function makePicker(deps: any = {}) {
  const picker: any = createTrackPicker({
    share: deps.share ?? vi.fn(async () => ({ ok: true })),
    loadPlaylist: deps.loadPlaylist ?? vi.fn(async () => ({ tracks: [], count: 0 })),
  });
  picker.$nextTick = (fn: () => void) => fn();
  picker.$refs = { trackSearchInput: { focus: vi.fn() } };
  picker.load = vi.fn(async () => {});
  picker.scrollToBottom = vi.fn();
  return picker;
}

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
  vi.mocked(play).mockClear();
  vi.mocked(togglePlayPause).mockClear();
  vi.mocked(isCurrentTrack).mockReset().mockReturnValue(false);
});

describe('track picker', () => {
  it('loads what is currently playing when opened', async () => {
    stubApi((path) => {
      if (path === '/api/me/now-playing') {
        return new Response(
          JSON.stringify({ playing: { spotifyTrackId: 'sp1', name: 'Landslide', artistName: 'FM', imageUrl: 'i' }, track: { id: 'sp1' } }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    });
    const picker = makePicker();

    await picker.openTrackPicker();

    expect(picker.showTrackPicker).toBe(true);
    expect(picker.nowPlaying.name).toBe('Landslide');
    expect(picker.nowPlayingRaw).toEqual({ id: 'sp1' });
    vi.unstubAllGlobals();
  });

  it('opens fine with nothing playing -- the one-tap option just does not appear', async () => {
    stubApi(() => new Response(JSON.stringify({ playing: null }), { status: 200 }));
    const picker = makePicker();

    await picker.openTrackPicker();

    expect(picker.showTrackPicker).toBe(true);
    expect(picker.nowPlaying).toBeNull();
    vi.unstubAllGlobals();
  });

  it('opens fine when the now-playing lookup fails outright', async () => {
    stubApi(() => new Response('nope', { status: 500 }));
    const picker = makePicker();

    await picker.openTrackPicker();

    expect(picker.showTrackPicker).toBe(true);
    expect(picker.nowPlaying).toBeNull();
    expect(showErrorToast).not.toHaveBeenCalled(); // silent -- search still works
    vi.unstubAllGlobals();
  });

  it('does not search on a query shorter than two characters', async () => {
    const picker = makePicker();
    picker.debouncedTrackSearch = vi.fn();
    picker.trackQuery = 'a';

    picker.onTrackQueryInput();

    expect(picker.debouncedTrackSearch).not.toHaveBeenCalled();
    expect(picker.trackResults).toEqual([]);
  });

  it('searches once the query is long enough', async () => {
    const picker = makePicker();
    picker.debouncedTrackSearch = vi.fn();
    picker.trackQuery = 'landslide';

    picker.onTrackQueryInput();

    expect(picker.debouncedTrackSearch).toHaveBeenCalled();
  });

  it('shares the currently-playing track using the raw Spotify object', async () => {
    const share = vi.fn(async () => ({ ok: true }));
    const picker = makePicker({ share });
    picker.nowPlayingRaw = { id: 'sp1', name: 'Landslide', artists: [{ id: 'a', name: 'FM' }] };
    picker.trackCaption = 'this one';

    await picker.shareNowPlaying();

    expect(share).toHaveBeenCalledWith(picker.nowPlayingRaw, 'this one');
  });

  it('shares a search result as a Spotify-shaped object the server can resolve', async () => {
    const share = vi.fn(async () => ({ ok: true }));
    const picker = makePicker({ share });

    await picker.shareSearchResult({
      spotifyTrackId: 'sp2',
      name: 'Dreams',
      artistName: 'Fleetwood Mac',
      imageUrl: 'https://i/x.jpg',
    });

    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sp2',
        name: 'Dreams',
        artists: [expect.objectContaining({ name: 'Fleetwood Mac' })],
      }),
      ''
    );
  });

  it('closes the picker and refreshes the thread and playlist after a successful share', async () => {
    const loadPlaylist = vi.fn(async () => ({ tracks: [{ id: 't1' }], count: 1 }));
    const picker = makePicker({ loadPlaylist });
    picker.showTrackPicker = true;

    await picker.shareTrack({ id: 'sp1', name: 'x' });

    expect(picker.showTrackPicker).toBe(false);
    expect(picker.load).toHaveBeenCalled();
    expect(picker.playlistCount).toBe(1);
  });

  it('surfaces the Spotify-busy case distinctly from a generic failure', async () => {
    const share = vi.fn(async () => {
      const err: any = new Error('nope');
      err.status = 503;
      err.body = { error: 'artist_unavailable' };
      throw err;
    });
    const picker = makePicker({ share });

    await picker.shareTrack({ id: 'sp1', name: 'x' });

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('busy'));
    expect(picker.sharingTrack).toBe(false); // never left stuck
  });

  it('points at the messaging gate when the profile is incomplete', async () => {
    const share = vi.fn(async () => {
      const err: any = new Error('nope');
      err.status = 403;
      err.body = { error: 'profile_incomplete' };
      throw err;
    });
    const picker = makePicker({ share });

    await picker.shareTrack({ id: 'sp1', name: 'x' });

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('Settings'));
  });

  it('ignores a second share while one is already in flight', async () => {
    let resolve: (v: any) => void = () => {};
    const share = vi.fn(() => new Promise((r) => { resolve = r; }));
    const picker = makePicker({ share });

    const first = picker.shareTrack({ id: 'sp1', name: 'x' });
    await picker.shareTrack({ id: 'sp2', name: 'y' }); // must be dropped
    resolve({ ok: true });
    await first;

    expect(share).toHaveBeenCalledTimes(1);
  });

  it('plays a shared track through the persistent player bar', async () => {
    const picker = makePicker();

    await picker.playSharedTrack({ id: 't1', spotifyId: 'sp1', name: 'Song', artistName: 'A', imageUrl: 'i', durationMs: 200000 });

    expect(play).toHaveBeenCalledWith({ spotifyId: 'sp1', id: 't1', name: 'Song', artistName: 'A', imageUrl: 'i', durationMs: 200000 });
  });

  it('pauses instead of restarting when the tapped track is already playing', async () => {
    vi.mocked(isCurrentTrack).mockReturnValue(true);
    const picker = makePicker();

    await picker.playSharedTrack({ id: 't1', spotifyId: 'sp1', name: 'Song' });

    expect(togglePlayPause).toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it('is a no-op when asked to play nothing', async () => {
    const picker = makePicker();
    await picker.playSharedTrack(null);
    expect(play).not.toHaveBeenCalled();
    expect(togglePlayPause).not.toHaveBeenCalled();
  });

  it('keeps the thread usable when the playlist refresh fails', async () => {
    const loadPlaylist = vi.fn(async () => {
      throw new Error('boom');
    });
    const picker = makePicker({ loadPlaylist });

    await picker.refreshPlaylist();

    expect(picker.playlistCount).toBe(0);
    expect(showErrorToast).not.toHaveBeenCalled();
  });
});
