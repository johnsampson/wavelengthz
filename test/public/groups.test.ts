import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGroupsApp } from '../../public/groups.js';
import { showErrorToast } from '../../public/toast.js';
import { navigate } from '../../public/router.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));
vi.mock('../../public/router.js', () => ({ navigate: vi.fn() }));

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
  vi.mocked(navigate).mockClear();
});

function stubApi(handler: (path: string, options?: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => handler(path, options)));
}

describe('groups list', () => {
  it('loads groups on init when authed', async () => {
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path === '/api/groups') return new Response(JSON.stringify({ groups: [{ id: 'g1', name: 'Indie fans' }] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createGroupsApp();

    await app.init();

    expect(app.groups).toEqual([{ id: 'g1', name: 'Indie fans' }]);
    vi.unstubAllGlobals();
  });

  it('clears the create form and reloads after a successful create', async () => {
    let created = false;
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path === '/api/groups' && !created) {
        created = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path === '/api/groups') return new Response(JSON.stringify({ groups: [{ id: 'g1', name: 'New group' }] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createGroupsApp();
    app.newName = 'New group';
    app.showCreate = true;

    await app.create();

    expect(app.newName).toBe('');
    expect(app.showCreate).toBe(false);
    expect(app.groups).toEqual([{ id: 'g1', name: 'New group' }]);
    vi.unstubAllGlobals();
  });

  it('does not submit an empty group name', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = createGroupsApp();
    app.newName = '   ';

    await app.create();

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shows a specific toast when joining a full group', async () => {
    stubApi((path) => {
      if (path.endsWith('/join')) return new Response(JSON.stringify({ error: 'group_full' }), { status: 403 });
      return new Response('{}', { status: 200 });
    });
    const app = createGroupsApp();

    await app.join({ id: 'g1' });

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('full'));
    vi.unstubAllGlobals();
  });

  it('navigates into the group after successfully joining', async () => {
    stubApi((path) => {
      if (path.endsWith('/join')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 200 });
    });
    const app = createGroupsApp();

    await app.join({ id: 'g1' });

    expect(navigate).toHaveBeenCalledWith('/group?id=g1');
    vi.unstubAllGlobals();
  });
});

describe('starting a group from a song (issue #127)', () => {
  function makeApp() {
    const app: any = createGroupsApp();
    // Same $nextTick/$refs faking test/public/trackPicker.test.ts already
    // uses for its own openTrackPicker() -- requestAnimationFrame doesn't
    // exist in this test pool (domUtils.js's raf falls back to an immediate
    // call), so a synchronous $nextTick runs the whole focusAfterReveal
    // chain inline, and the whole thing is testable with no real DOM.
    app.$nextTick = (fn: () => void) => fn();
    app.$refs = { songSearchInput: { focus: vi.fn() } };
    return app;
  }

  it('openSongPicker resets state and focuses the search input', () => {
    const app = makeApp();
    app.songQuery = 'stale query';
    app.songResults = [{ name: 'stale' }];

    app.openSongPicker();

    expect(app.showSongPicker).toBe(true);
    expect(app.songQuery).toBe('');
    expect(app.songResults).toEqual([]);
    expect(app.$refs.songSearchInput.focus).toHaveBeenCalled();
  });

  it('onSongQueryInput does not search below the 2-character threshold', () => {
    const app = makeApp();
    app.debouncedSongSearch = vi.fn();
    app.songQuery = 'a';

    app.onSongQueryInput();

    expect(app.debouncedSongSearch).not.toHaveBeenCalled();
    expect(app.songResults).toEqual([]);
  });

  it('onSongQueryInput debounces a search at 2+ characters', () => {
    const app = makeApp();
    app.debouncedSongSearch = vi.fn();
    app.songQuery = 'ra';

    app.onSongQueryInput();

    expect(app.debouncedSongSearch).toHaveBeenCalled();
  });

  it('runSongSearch populates songResults from the track-search endpoint', async () => {
    stubApi((path) => {
      if (path.startsWith('/api/tracks/search')) {
        return new Response(JSON.stringify({ results: [{ name: 'Song One', spotifyTrackId: 'sp-t1' }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const app = makeApp();
    app.songQuery = 'song one';

    await app.runSongSearch();

    expect(app.songResults).toEqual([{ name: 'Song One', spotifyTrackId: 'sp-t1' }]);
    expect(app.songSearching).toBe(false);
    vi.unstubAllGlobals();
  });

  it('runSongSearch shows an error toast and clears the searching flag on failure', async () => {
    stubApi(() => new Response('nope', { status: 500 }));
    const app = makeApp();
    app.songQuery = 'song one';

    await app.runSongSearch();

    expect(showErrorToast).toHaveBeenCalled();
    expect(app.songSearching).toBe(false);
    vi.unstubAllGlobals();
  });

  it('pickSong stores the display + raw shapes and closes the picker', () => {
    const app = makeApp();
    app.showSongPicker = true;
    app.songQuery = 'lingering';
    app.songResults = [{ name: 'irrelevant' }];

    app.pickSong({ spotifyTrackId: 'sp-t1', spotifyArtistId: 'sp-a1', name: 'Song One', artistName: 'Artist One', imageUrl: 'https://img/t1.jpg' });

    expect(app.selectedSong).toEqual({ name: 'Song One', artistName: 'Artist One', imageUrl: 'https://img/t1.jpg' });
    expect(app.selectedSongRaw).toEqual({
      id: 'sp-t1',
      name: 'Song One',
      artists: [{ id: 'sp-a1', name: 'Artist One' }],
      album: { images: [{ url: 'https://img/t1.jpg' }] },
    });
    expect(app.showSongPicker).toBe(false);
    expect(app.songQuery).toBe('');
    expect(app.songResults).toEqual([]);
  });

  it('clearSelectedSong resets both the display and raw song state', () => {
    const app = makeApp();
    app.selectedSong = { name: 'Song One' };
    app.selectedSongRaw = { id: 'sp-t1' };

    app.clearSelectedSong();

    expect(app.selectedSong).toBeNull();
    expect(app.selectedSongRaw).toBeNull();
  });

  it('create() sends the selected song along with the group', async () => {
    let sentBody: any = null;
    stubApi((path, options) => {
      if (path === '/api/groups' && options?.method === 'POST') {
        sentBody = JSON.parse(options.body as string);
        return new Response(JSON.stringify({ ok: true, groupId: 'g1' }), { status: 200 });
      }
      if (path === '/api/groups') return new Response(JSON.stringify({ groups: [] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = makeApp();
    app.newName = 'Crate Diggers';
    app.selectedSongRaw = { id: 'sp-t1', name: 'Song One' };

    await app.create();

    expect(sentBody.track).toEqual({ id: 'sp-t1', name: 'Song One' });
    expect(app.selectedSong).toBeNull();
    expect(app.selectedSongRaw).toBeNull();
    vi.unstubAllGlobals();
  });

  it('create() shows a specific toast when Spotify is temporarily unavailable for the seed track', async () => {
    stubApi(() => new Response(JSON.stringify({ error: 'artist_unavailable' }), { status: 503 }));
    const app = makeApp();
    app.newName = 'Crate Diggers';
    app.selectedSongRaw = { id: 'sp-t1', name: 'Song One' };

    await app.create();

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining("Spotify's a little busy"));
    vi.unstubAllGlobals();
  });
});
