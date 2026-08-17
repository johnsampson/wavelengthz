import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDeckApp } from '../../public/index.js';
import { showErrorToast } from '../../public/toast.js';
import { play, togglePlayPause, isCurrentTrack } from '../../public/playerBar.js';
import { attachSwipeDeck } from '../../public/swipe.js';
import { navigate } from '../../public/router.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));
vi.mock('../../public/playerBar.js', () => ({
  play: vi.fn(),
  togglePlayPause: vi.fn(),
  isCurrentTrack: vi.fn(() => false),
}));
vi.mock('../../public/swipe.js', () => ({ attachSwipeDeck: vi.fn() }));
vi.mock('../../public/router.js', () => ({ navigate: vi.fn() }));

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
}

function fakeWindow() {
  return { location: { href: '' } };
}

function stubApi(handler: (path: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => handler(path)));
}

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
  vi.mocked(play).mockClear();
  vi.mocked(togglePlayPause).mockClear();
  vi.mocked(isCurrentTrack).mockReset().mockReturnValue(false);
  vi.mocked(attachSwipeDeck).mockReset().mockReturnValue(vi.fn());
  vi.mocked(navigate).mockClear();
  vi.stubGlobal('localStorage', fakeStorage());
  vi.stubGlobal('sessionStorage', fakeStorage());
});

describe('deck app', () => {
  it('loads a candidate queue on init when authed', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path.startsWith('/api/candidates/'))
        return new Response(JSON.stringify({ candidates: [{ id: 'c1', displayName: 'Sam' }] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createDeckApp();
    (app as any).$nextTick = (fn: () => void) => fn();

    await app.init();

    expect(app.authed).toBe(true);
    expect(app.current).toEqual({ id: 'c1', displayName: 'Sam' });
    app.destroy();
  });

  it('shows the logged-out state without loading a queue when not authed', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    stubApi(() => new Response('nope', { status: 401 }));
    const app = createDeckApp();

    await app.init();

    expect(app.authed).toBe(false);
    expect(app.current).toBeNull();
  });

  it('destroy() detaches the swipe-deck listener attached by showNext()', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => ({})) });
    const detach = vi.fn();
    vi.mocked(attachSwipeDeck).mockReturnValue(detach);
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path.startsWith('/api/candidates/'))
        return new Response(JSON.stringify({ candidates: [{ id: 'c1', displayName: 'Sam' }] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createDeckApp();
    (app as any).$nextTick = (fn: () => void) => fn();

    await app.init();
    expect(app.detachSwipe).toBe(detach);

    app.destroy();

    expect(detach).toHaveBeenCalled();
    expect(app.detachSwipe).toBeNull();
  });

  it('destroy() is a safe no-op when nothing was ever attached', () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createDeckApp();

    expect(() => app.destroy()).not.toThrow();
  });

  it('toggleAnthem toggles pause on the currently-playing anthem instead of restarting it', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.mocked(isCurrentTrack).mockReturnValue(true);
    const app = createDeckApp();
    app.current = { anthemTrack: { spotifyId: 'sp1', name: 'Song', imageUrl: 'img' } };

    await app.toggleAnthem();

    expect(togglePlayPause).toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it('toggleAnthem hands off a new anthem to the player bar', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.mocked(isCurrentTrack).mockReturnValue(false);
    const app = createDeckApp();
    app.current = { anthemTrack: { spotifyId: 'sp1', id: 'sp1', name: 'Song', artistName: 'Some Artist', imageUrl: 'img' } };

    await app.toggleAnthem();

    expect(play).toHaveBeenCalledWith({ spotifyId: 'sp1', id: 'sp1', name: 'Song', artistName: 'Some Artist', imageUrl: 'img' });
  });

  it('toggleAnthem is a no-op when the current card has no anthem', async () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createDeckApp();
    app.current = { anthemTrack: null };

    await app.toggleAnthem();

    expect(play).not.toHaveBeenCalled();
    expect(togglePlayPause).not.toHaveBeenCalled();
  });

  it('togglePreviewTrack toggles pause on the currently-playing preview track instead of restarting it', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.mocked(isCurrentTrack).mockReturnValue(true);
    const app = createDeckApp();
    app.current = { name: 'Some Artist', track: { spotifyId: 'sp1', id: 't1', name: 'Song', imageUrl: 'img' } };

    await app.togglePreviewTrack();

    expect(togglePlayPause).toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it('togglePreviewTrack hands off a new preview track to the player bar, tagged with the current artist name', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.mocked(isCurrentTrack).mockReturnValue(false);
    const app = createDeckApp();
    app.current = { name: 'Some Artist', track: { spotifyId: 'sp1', id: 't1', name: 'Song', imageUrl: 'img', durationMs: 180000 } };

    await app.togglePreviewTrack();

    // durationMs rides along so the bar can start at the hook rather than 0:00.
    expect(play).toHaveBeenCalledWith({ spotifyId: 'sp1', id: 't1', name: 'Song', artistName: 'Some Artist', imageUrl: 'img', durationMs: 180000 });
  });

  it('togglePreviewTrack is a no-op when the current card has no catalog track', async () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createDeckApp();
    app.current = { name: 'Some Artist', track: null };

    await app.togglePreviewTrack();

    expect(play).not.toHaveBeenCalled();
    expect(togglePlayPause).not.toHaveBeenCalled();
  });

  // Explicit product rule: radio continues something the listener started,
  // but arriving at the deck -- or advancing to a new card -- never starts
  // anything on its own. Only a deliberate tap changes what's playing.
  it('never starts playback just from loading the deck, even with a playable card', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path.startsWith('/api/candidates/'))
        return new Response(
          JSON.stringify({
            candidates: [
              { itemType: 'artist', itemId: 'a1', name: 'Depeche Mode', track: { spotifyId: 'sp1', id: 't1', name: 'Song', durationMs: 200000 } },
            ],
          }),
          { status: 200 }
        );
      return new Response('not found', { status: 404 });
    });
    const app = createDeckApp();
    (app as any).$nextTick = (fn: () => void) => fn();

    await app.init();

    expect(app.current?.track).toBeTruthy(); // the card really is playable
    expect(play).not.toHaveBeenCalled();
    app.destroy();
  });

  it('never starts playback when advancing to the next card', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ artist: {}, tracks: [] }), { status: 200 })));
    const app = createDeckApp();
    app.mode = 'music';
    (app as any).$nextTick = (fn: () => void) => fn();
    app.queue = [
      { itemType: 'artist', itemId: 'a1', name: 'A', track: { spotifyId: 'sp1', id: 't1', name: 'S', durationMs: 200000 } },
      { itemType: 'artist', itemId: 'a2', name: 'B', track: { spotifyId: 'sp2', id: 't2', name: 'S2', durationMs: 200000 } },
    ];

    await app.showNext();
    await app.showNext();

    expect(play).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('viewArtist routes to the current candidate\'s artist profile in Music mode', () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createDeckApp();
    app.mode = 'music';
    app.current = { itemId: 'a1', name: 'Some Artist' };

    app.viewArtist();

    expect(navigate).toHaveBeenCalledWith('/artist?id=a1');
  });

  it('viewArtist is a no-op in People mode -- displayName is not a link to an artist', () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createDeckApp();
    app.mode = 'people';
    app.current = { id: 'u2', displayName: 'Sam' };

    app.viewArtist();

    expect(navigate).not.toHaveBeenCalled();
  });

  it('viewArtist is a no-op with no current candidate', () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createDeckApp();
    app.mode = 'music';
    app.current = null;

    app.viewArtist();

    expect(navigate).not.toHaveBeenCalled();
  });

  it('showNext prefetches the next queued artist in Music mode, warming GET /api/artists/:id ahead of an actual visit', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/artists/a2') return new Response(JSON.stringify({ artist: {}, tracks: [] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createDeckApp();
    app.mode = 'music';
    (app as any).$nextTick = (fn: () => void) => fn();
    app.queue = [
      { itemType: 'artist', itemId: 'a1', name: 'First' },
      { itemType: 'artist', itemId: 'a2', name: 'Second' },
    ];

    await app.showNext();

    expect(app.current).toEqual({ itemType: 'artist', itemId: 'a1', name: 'First' });
    expect(fetchMock).toHaveBeenCalledWith('/api/artists/a2', expect.anything());
    vi.unstubAllGlobals();
  });

  it('showNext does not prefetch in People mode', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const app = createDeckApp();
    app.mode = 'people';
    (app as any).$nextTick = (fn: () => void) => fn();
    app.queue = [{ id: 'u1', displayName: 'First' }, { id: 'u2', displayName: 'Second' }];

    await app.showNext();

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('showNext does not prefetch when nothing remains queued after this card', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const app = createDeckApp();
    app.mode = 'music';
    (app as any).$nextTick = (fn: () => void) => fn();
    app.queue = [{ itemType: 'artist', itemId: 'a1', name: 'First' }];

    await app.showNext();

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('setMode persists the choice and reloads the queue without stopping playback', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    stubApi((path) => {
      if (path.startsWith('/api/candidates/')) return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createDeckApp();
    (app as any).$nextTick = (fn: () => void) => fn();

    await app.setMode('music');

    expect(app.mode).toBe('music');
    expect(storage.getItem('wl_deck_mode')).toBe('music');
    vi.unstubAllGlobals();
  });

  it('viewProfile routes to the current candidate\'s profile without a full reload', () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createDeckApp();
    app.current = { id: 'u2', displayName: 'Sam' };

    app.viewProfile();

    expect(navigate).toHaveBeenCalledWith('/profile?id=u2');
  });

  it('viewProfile is a no-op with no current candidate', () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createDeckApp();
    app.current = null;

    app.viewProfile();

    expect(navigate).not.toHaveBeenCalled();
  });

  it('selectArtist routes straight to an already-cataloged artist', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('sessionStorage', fakeStorage());
    const app = createDeckApp();

    await app.selectArtist({ id: 'a1', inCatalog: true });

    expect(navigate).toHaveBeenCalledWith('/artist?id=a1');
  });

  it('selectArtist creates then routes to an artist not yet in the catalog', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('sessionStorage', fakeStorage());
    stubApi((path) => {
      if (path === '/api/artists') return new Response(JSON.stringify({ artistId: 'new-a1' }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createDeckApp();

    await app.selectArtist({ spotifyArtistId: 'sp-a1', inCatalog: false });

    expect(navigate).toHaveBeenCalledWith('/artist?id=new-a1');
    vi.unstubAllGlobals();
  });

  it('selectArtist growls a toast when creating the artist fails', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('sessionStorage', fakeStorage());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createDeckApp();

    await app.selectArtist({ spotifyArtistId: 'sp-a1', inCatalog: false });

    expect(navigate).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('artist'));
    vi.unstubAllGlobals();
  });
});
