import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDeckApp, preloadCandidateImage } from '../../public/index.js';
import { showToast, showErrorToast } from '../../public/toast.js';
import { play, togglePlayPause, isCurrentTrack, onNowPlayingChange } from '../../public/playerBar.js';
import { attachSwipeDeck } from '../../public/swipe.js';
import { navigate } from '../../public/router.js';

vi.mock('../../public/toast.js', () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }));
vi.mock('../../public/playerBar.js', () => ({
  play: vi.fn(),
  togglePlayPause: vi.fn(),
  isCurrentTrack: vi.fn(() => false),
  onNowPlayingChange: vi.fn(() => vi.fn()),
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

// Stands in for both '#card' and '#wl-card-preview-host' -- a bare {}
// was fine while nothing but the (fully-mocked) attachSwipeDeck touched
// the element, but showCardPreviewEmbed/hideCardPreviewEmbed (issue
// #159/#160) call real DOM methods on whatever getElementById returns.
function fakeDomElement() {
  return { classList: { add: vi.fn(), remove: vi.fn() }, appendChild: vi.fn(), innerHTML: '' };
}

function stubApi(handler: (path: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => handler(path)));
}

beforeEach(() => {
  vi.mocked(showToast).mockClear();
  vi.mocked(showErrorToast).mockClear();
  vi.mocked(play).mockClear();
  vi.mocked(togglePlayPause).mockClear();
  vi.mocked(isCurrentTrack).mockReset().mockReturnValue(false);
  vi.mocked(onNowPlayingChange).mockReset().mockReturnValue(vi.fn());
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

  // Issue #161: records reach even for a logged-out visitor -- the whole
  // point is counting people beyond identified accounts too.
  it('records a session_start analytics event on init, even when not authed', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    const fetchMock = vi.fn(async (path: string, options?: any) => {
      if (path === '/api/me') return new Response('nope', { status: 401 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createDeckApp();

    await app.init();

    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/analytics/event');
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as any).body);
    // Issue #168: clientId/sessionId ride along on every event for GA4
    // forwarding -- asserted as "some string", not an exact UUID, since
    // the actual value is randomly generated.
    expect(body).toEqual({ eventType: 'session_start', metadata: undefined, clientId: expect.any(String), sessionId: expect.any(String) });
  });

  it('does not record a second session_start event on a second init() within the same session', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    const fetchMock = vi.fn(async (path: string, options?: any) => {
      if (path === '/api/me') return new Response('nope', { status: 401 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createDeckApp();
    await app.init();
    const firstCallCount = fetchMock.mock.calls.filter((c) => c[0] === '/api/analytics/event').length;
    expect(firstCallCount).toBe(1);

    await app.init(); // e.g. re-entering the page within the same tab session

    const totalCallCount = fetchMock.mock.calls.filter((c) => c[0] === '/api/analytics/event').length;
    expect(totalCallCount).toBe(1);
  });

  it('destroy() detaches the swipe-deck listener attached by showNext()', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => fakeDomElement()) });
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

  // issue #145 (Round 7): "make the entire artist card clickable to the
  // profile, not just the artist name" -- attachSwipeDeck's onTap (fired on
  // a genuine tap, not a drag/swipe) should route the same place the name
  // button's own click handler already does.
  it('showNext wires onTap to viewArtist in Music mode', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => fakeDomElement()) });
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path.startsWith('/api/candidates/'))
        return new Response(JSON.stringify({ candidates: [{ id: 'c1', itemId: 'a1', name: 'Artist' }] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app: any = createDeckApp();
    app.$nextTick = (fn: () => void) => fn();
    app.mode = 'music';

    await app.init();

    const onTap = (vi.mocked(attachSwipeDeck).mock.calls.at(-1) as any)?.[1]?.onTap;
    expect(typeof onTap).toBe('function');
    onTap();

    expect(navigate).toHaveBeenCalledWith('/artist?id=a1');
  });

  it('showNext wires onTap to viewProfile in People mode', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => fakeDomElement()) });
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path.startsWith('/api/candidates/'))
        return new Response(JSON.stringify({ candidates: [{ id: 'c1', displayName: 'Sam' }] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app: any = createDeckApp();
    app.$nextTick = (fn: () => void) => fn();
    app.mode = 'people';

    await app.init();

    const onTap = (vi.mocked(attachSwipeDeck).mock.calls.at(-1) as any)?.[1]?.onTap;
    expect(typeof onTap).toBe('function');
    onTap();

    expect(navigate).toHaveBeenCalledWith('/profile?id=c1');
  });

  it('destroy() is a safe no-op when nothing was ever attached', () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    const app = createDeckApp();

    expect(() => app.destroy()).not.toThrow();
  });

  // Radio auto-advancing to a new track (or any other page/tap starting one)
  // changes playerBar.js's own module state, which isCurrentAnthem has no
  // way to notice on its own -- see index.js's nowPlayingTick comment.
  // init() must subscribe so Alpine has something to actually re-run that
  // binding on. (Music mode's own preview track no longer reads
  // playerBar.js's state at all as of issue #159/#160 -- it plays via its
  // own self-contained card embed now, not a hand-off to the shared bar.)
  it('subscribes to now-playing changes on init and bumps nowPlayingTick so isCurrentAnthem re-evaluates', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    stubApi(() => new Response('nope', { status: 401 }));
    let firePlayerChange: (() => void) | undefined;
    vi.mocked(onNowPlayingChange).mockImplementation((cb: () => void) => {
      firePlayerChange = cb;
      return vi.fn();
    });
    const app = createDeckApp();

    await app.init();

    expect(onNowPlayingChange).toHaveBeenCalled();
    expect(app.nowPlayingTick).toBe(0);
    firePlayerChange?.();
    expect(app.nowPlayingTick).toBe(1);
    app.current = { anthemTrack: { spotifyId: 'sp1', name: 'Song' } };
    vi.mocked(isCurrentTrack).mockReturnValue(true);
    expect(app.isCurrentAnthem()).toBe(true);
    app.destroy();
  });

  it('destroy() unsubscribes from now-playing changes', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    stubApi(() => new Response('nope', { status: 401 }));
    const unsubscribe = vi.fn();
    vi.mocked(onNowPlayingChange).mockReturnValue(unsubscribe);
    const app = createDeckApp();
    await app.init();

    app.destroy();

    expect(unsubscribe).toHaveBeenCalled();
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

  it('toggleAnthem records a song_play analytics event for a fresh play, but not a resume', async () => {
    vi.stubGlobal('window', fakeWindow());
    const fetchMock = vi.fn(async (path?: string, options?: any) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(isCurrentTrack).mockReturnValue(false);
    const app = createDeckApp();
    app.current = { anthemTrack: { spotifyId: 'sp1', id: 'sp1', name: 'Song', artistName: 'Some Artist', imageUrl: 'img' } };

    await app.toggleAnthem();

    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/analytics/event');
    expect(call).toBeTruthy();
    expect(JSON.parse((call![1] as any).body)).toEqual({
      eventType: 'song_play',
      metadata: { trackId: 'sp1' },
      clientId: expect.any(String),
      sessionId: expect.any(String),
    });

    fetchMock.mockClear();
    vi.mocked(isCurrentTrack).mockReturnValue(true); // now "currently playing" -- next call is a resume
    await app.toggleAnthem();
    expect(fetchMock.mock.calls.find((c) => c[0] === '/api/analytics/event')).toBeUndefined();
  });

  it('toggleAnthem is a no-op when the current card has no anthem', async () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createDeckApp();
    app.current = { anthemTrack: null };

    await app.toggleAnthem();

    expect(play).not.toHaveBeenCalled();
    expect(togglePlayPause).not.toHaveBeenCalled();
  });

  // issue #159/#160 (part of the 250K-users strategy): the deck card's
  // representative track now plays via its own inline Spotify embed,
  // mounted/torn down imperatively by showNext() -- these replace the old
  // togglePreviewTrack tests (that hand-off-to-the-shared-bar chip no
  // longer exists).
  function fakeDocumentWithCardHost() {
    const host = fakeDomElement();
    const card = fakeDomElement();
    const iframe: any = {};
    const getElementById = vi.fn((id: string) => (id === 'wl-card-preview-host' ? host : id === 'card' ? card : null));
    const createElement = vi.fn(() => iframe);
    return { getElementById, createElement, host, card, iframe };
  }

  it('showNext mounts an inline embed for the new candidate\'s representative track in Music mode', async () => {
    vi.stubGlobal('window', fakeWindow());
    const doc = fakeDocumentWithCardHost();
    vi.stubGlobal('document', doc);
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path.startsWith('/api/candidates/'))
        return new Response(
          JSON.stringify({ candidates: [{ id: 'c1', itemId: 'a1', name: 'Artist', track: { spotifyId: 'sp1', id: 't1', name: 'Song' } }] }),
          { status: 200 }
        );
      return new Response('not found', { status: 404 });
    });
    const app: any = createDeckApp();
    app.$nextTick = (fn: () => void) => fn();
    app.mode = 'music';

    await app.init();

    expect(doc.createElement).toHaveBeenCalledWith('iframe');
    expect(doc.iframe.src).toBe('https://open.spotify.com/embed/track/sp1?theme=0&autoplay=1');
    expect(doc.host.appendChild).toHaveBeenCalledWith(doc.iframe);
    expect(doc.host.classList.remove).toHaveBeenCalledWith('hidden');
  });

  it('showNext tears down the card embed when the new candidate has no catalog track', async () => {
    vi.stubGlobal('window', fakeWindow());
    const doc = fakeDocumentWithCardHost();
    vi.stubGlobal('document', doc);
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path.startsWith('/api/candidates/'))
        return new Response(JSON.stringify({ candidates: [{ id: 'c1', itemId: 'a1', name: 'Artist', track: null }] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app: any = createDeckApp();
    app.$nextTick = (fn: () => void) => fn();
    app.mode = 'music';

    await app.init();

    expect(doc.createElement).not.toHaveBeenCalled();
    expect(doc.host.classList.add).toHaveBeenCalledWith('hidden');
  });

  // Issue #161: showCardPreviewEmbed (issue #159/#160's replacement for the
  // old togglePreviewTrack chip) is now the actual "fresh play" moment for
  // Music mode's card -- there's no more "already playing, so pause"
  // resume branch to distinguish, since the embed remounts fresh on every
  // card advance rather than toggling play/pause on a persistent bar.
  it('records a song_play analytics event when showNext mounts a card embed', async () => {
    vi.stubGlobal('window', fakeWindow());
    const doc = fakeDocumentWithCardHost();
    vi.stubGlobal('document', doc);
    const fetchMock = vi.fn(async (path: string, options?: any) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path.startsWith('/api/candidates/'))
        return new Response(
          JSON.stringify({ candidates: [{ id: 'c1', itemId: 'a1', name: 'Artist', track: { spotifyId: 'sp1', id: 't1', name: 'Song' } }] }),
          { status: 200 }
        );
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app: any = createDeckApp();
    app.$nextTick = (fn: () => void) => fn();
    app.mode = 'music';

    await app.init();

    // init() also fires its own session_start analytics event -- find the
    // song_play one specifically rather than the first analytics call.
    const analyticsCalls = fetchMock.mock.calls.filter((c) => c[0] === '/api/analytics/event');
    const call = analyticsCalls.find((c) => JSON.parse((c[1] as any).body).eventType === 'song_play');
    expect(call).toBeTruthy();
    expect(JSON.parse((call![1] as any).body)).toEqual({
      eventType: 'song_play',
      metadata: { spotifyId: 'sp1' },
      clientId: expect.any(String),
      sessionId: expect.any(String),
    });
  });

  it('showNext never mounts the card embed in People mode, even if a candidate carries a track field', async () => {
    vi.stubGlobal('window', fakeWindow());
    const doc = fakeDocumentWithCardHost();
    vi.stubGlobal('document', doc);
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path.startsWith('/api/candidates/'))
        return new Response(
          JSON.stringify({ candidates: [{ id: 'c1', displayName: 'Sam', track: { spotifyId: 'sp1', id: 't1', name: 'Song' } }] }),
          { status: 200 }
        );
      return new Response('not found', { status: 404 });
    });
    const app: any = createDeckApp();
    app.$nextTick = (fn: () => void) => fn();
    app.mode = 'people';

    await app.init();

    expect(doc.createElement).not.toHaveBeenCalled();
    expect(doc.host.classList.add).toHaveBeenCalledWith('hidden');
  });

  it('destroy() tears down the card\'s own preview embed', async () => {
    vi.stubGlobal('window', fakeWindow());
    const doc = fakeDocumentWithCardHost();
    vi.stubGlobal('document', doc);
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path.startsWith('/api/candidates/'))
        return new Response(
          JSON.stringify({ candidates: [{ id: 'c1', itemId: 'a1', name: 'Artist', track: { spotifyId: 'sp1', id: 't1', name: 'Song' } }] }),
          { status: 200 }
        );
      return new Response('not found', { status: 404 });
    });
    const app: any = createDeckApp();
    app.$nextTick = (fn: () => void) => fn();
    app.mode = 'music';
    await app.init();
    doc.host.classList.add.mockClear();

    app.destroy();

    expect(doc.host.classList.add).toHaveBeenCalledWith('hidden');
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

  // issue #108: "on a slower connection after you slid the artist to the
  // left the artist picture reappears for a brief second before the next
  // artist picture shows." swipe.js's attachSwipeDeck reuses the same <img>
  // element across cards, so a not-yet-loaded next image leaves the
  // PREVIOUS one visible until it finishes downloading -- these confirm
  // showNext() preloads the upcoming candidate's image while it still has a
  // full swipe's worth of dwell time as queue[0], same as the artist-profile
  // prefetch just below it, but for the image in both modes.
  it('showNext preloads the next queued image in Music mode', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const urls: string[] = [];
    class FakeImage {
      set src(v: string) {
        urls.push(v);
      }
    }
    vi.stubGlobal('Image', FakeImage);
    const app = createDeckApp();
    app.mode = 'music';
    (app as any).$nextTick = (fn: () => void) => fn();
    app.queue = [
      { itemType: 'artist', itemId: 'a1', name: 'First', imageUrl: 'https://img.example/a1.jpg' },
      { itemType: 'artist', itemId: 'a2', name: 'Second', imageUrl: 'https://img.example/a2.jpg' },
    ];

    await app.showNext();

    expect(urls).toEqual(['https://img.example/a2.jpg']);
    vi.unstubAllGlobals();
  });

  it('showNext preloads the next queued photo in People mode', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const urls: string[] = [];
    class FakeImage {
      set src(v: string) {
        urls.push(v);
      }
    }
    vi.stubGlobal('Image', FakeImage);
    const app = createDeckApp();
    app.mode = 'people';
    (app as any).$nextTick = (fn: () => void) => fn();
    app.queue = [
      { id: 'u1', displayName: 'First', primaryPhotoUrl: 'https://img.example/u1.jpg' },
      { id: 'u2', displayName: 'Second', primaryPhotoUrl: 'https://img.example/u2.jpg' },
    ];

    await app.showNext();

    expect(urls).toEqual(['https://img.example/u2.jpg']);
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

  // issue #108: "I often try to find and like a track and I'm unable to" --
  // search only ever looked up artists, with no way to find a specific song.
  it('setSearchType switches to track search and re-runs immediately against the typed query', async () => {
    const fetchMock = vi.fn(async (path: string) =>
      path.startsWith('/api/tracks/search')
        ? new Response(JSON.stringify({ results: [{ spotifyTrackId: 't1', name: 'Song' }] }), { status: 200 })
        : new Response('not found', { status: 404 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = createDeckApp();
    app.searchQuery = 'land';

    app.setSearchType('track');
    await vi.waitFor(() => expect(app.searchResults).toHaveLength(1));

    expect(app.searchType).toBe('track');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/tracks/search?q=land'), expect.anything());
    vi.unstubAllGlobals();
  });

  it('setSearchType is a no-op when already on that type -- no redundant search', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = createDeckApp();

    app.setSearchType('artist');

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('runSearch calls the track endpoint, not the artist one, once searchType is track', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const app = createDeckApp();
    app.searchType = 'track';
    app.searchQuery = 'landslide';

    await app.runSearch();

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/tracks/search'), expect.anything());
    vi.unstubAllGlobals();
  });

  it('selectTrack likes an already-cataloged track directly, with no catalog round trip', async () => {
    const fetchMock = vi.fn(async (path: string) =>
      path === '/api/swipe/music' ? new Response(JSON.stringify({ ok: true }), { status: 200 }) : new Response('unexpected', { status: 500 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = createDeckApp();
    app.showSearch = true;

    await app.selectTrack({ id: 't1', name: 'Landslide', inCatalog: true });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/swipe/music',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ item_type: 'track', item_id: 't1', direction: 'right' }) })
    );
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Landslide') }));
    expect(app.showSearch).toBe(false); // closeSearch() ran
    vi.unstubAllGlobals();
  });

  it('selectTrack catalogs the artist then the track before liking one that is not yet cataloged', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (path: string, init?: any) => {
      calls.push(path);
      if (path === '/api/artists') return new Response(JSON.stringify({ artistId: 'new-a1' }), { status: 200 });
      if (path === '/api/tracks') {
        expect(JSON.parse(init.body)).toEqual({ spotifyTrackId: 'sp-t1', artistId: 'new-a1' });
        return new Response(JSON.stringify({ trackId: 'new-t1' }), { status: 200 });
      }
      if (path === '/api/swipe/music') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createDeckApp();

    await app.selectTrack({ spotifyTrackId: 'sp-t1', spotifyArtistId: 'sp-a1', name: 'New Song', inCatalog: false });

    expect(calls).toEqual(['/api/artists', '/api/tracks', '/api/swipe/music']);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/swipe/music',
      expect.objectContaining({ body: JSON.stringify({ item_type: 'track', item_id: 'new-t1', direction: 'right' }) })
    );
    vi.unstubAllGlobals();
  });

  it('selectTrack growls a toast and does not swipe when cataloging fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createDeckApp();

    await app.selectTrack({ spotifyTrackId: 'sp-t1', spotifyArtistId: 'sp-a1', name: 'New Song', inCatalog: false });

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('song'));
    expect(showToast).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('selectTrack ignores a second tap while the first is still in flight', async () => {
    let resolveSwipe: (() => void) | null = null;
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/swipe/music') {
        await new Promise<void>((resolve) => {
          resolveSwipe = resolve;
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createDeckApp();

    const first = app.selectTrack({ id: 't1', name: 'Landslide', inCatalog: true });
    const second = app.selectTrack({ id: 't1', name: 'Landslide', inCatalog: true });
    resolveSwipe!();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('search overlay (issue #127 item 7)', () => {
  function makeApp() {
    const app: any = createDeckApp();
    // No $nextTick faking here on purpose -- openSearch() is asserted to
    // reveal + focus synchronously now, not via $nextTick/rAF at all (see
    // domUtils.js's revealAndFocusSync). A real Alpine $nextTick would
    // still resolve fine since nothing here calls it, but leaving it
    // unset makes it obvious the test would fail loudly if openSearch()
    // ever started depending on it again.
    app.$refs = { searchOverlay: { style: { display: 'none' } }, searchInput: { focus: vi.fn() } };
    return app;
  }

  it('openSearch reveals the overlay and focuses the input synchronously, with no ticks in between', () => {
    const app = makeApp();

    app.openSearch();

    expect(app.showSearch).toBe(true);
    expect(app.$refs.searchOverlay.style.display).toBe('');
    expect(app.$refs.searchInput.focus).toHaveBeenCalled();
  });
});

describe('preloadCandidateImage', () => {
  function stubImage() {
    const urls: string[] = [];
    class FakeImage {
      set src(v: string) {
        urls.push(v);
      }
    }
    vi.stubGlobal('Image', FakeImage);
    return urls;
  }

  it('preloads the artist image in Music mode, not the (absent) photo field', () => {
    const urls = stubImage();

    preloadCandidateImage({ itemId: 'a1', imageUrl: 'https://img.example/a1.jpg' } as any, 'music');

    expect(urls).toEqual(['https://img.example/a1.jpg']);
    vi.unstubAllGlobals();
  });

  it('preloads the person photo in People mode, not the artist image field', () => {
    const urls = stubImage();

    preloadCandidateImage({ id: 'u1', primaryPhotoUrl: 'https://img.example/u1.jpg', imageUrl: 'https://img.example/wrong.jpg' } as any, 'people');

    expect(urls).toEqual(['https://img.example/u1.jpg']);
    vi.unstubAllGlobals();
  });

  it('does nothing for a candidate with no relevant image url (e.g. a photo-less person)', () => {
    const urls = stubImage();

    preloadCandidateImage({ id: 'u1' } as any, 'people');

    expect(urls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('does nothing for an undefined candidate -- the empty-queue case', () => {
    const urls = stubImage();

    expect(() => preloadCandidateImage(undefined, 'music')).not.toThrow();

    expect(urls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('does not throw when Image is undefined, same as this test pool', () => {
    vi.stubGlobal('Image', undefined);

    expect(() => preloadCandidateImage({ imageUrl: 'https://img.example/a.jpg' } as any, 'music')).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe('daily drop banner', () => {
  it('loadDailyDropPrompt sets the prompt text and answered flag', async () => {
    stubApi((path) => {
      if (path === '/api/daily-drop')
        return new Response(
          JSON.stringify({ prompt: { id: 'p1', text: "What's on repeat right now?" }, myAnswer: { name: 'Song' }, answerCount: 3 }),
          { status: 200 }
        );
      return new Response('not found', { status: 404 });
    });
    const app = createDeckApp();

    await app.loadDailyDropPrompt();

    expect(app.dailyDropPrompt).toEqual({ text: "What's on repeat right now?", answered: true });
  });

  it('loadDailyDropPrompt fails silently, leaving the banner hidden', async () => {
    stubApi(() => new Response('nope', { status: 500 }));
    const app = createDeckApp();

    await expect(app.loadDailyDropPrompt()).resolves.toBeUndefined();
    expect(app.dailyDropPrompt).toBeNull();
  });

  it('init() fetches the banner prompt (fire-and-forget, never blocks the deck)', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path.startsWith('/api/candidates/')) return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
      if (path === '/api/daily-drop')
        return new Response(JSON.stringify({ prompt: { id: 'p1', text: 'Prompt text' }, myAnswer: null, answerCount: 0 }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createDeckApp();
    (app as any).$nextTick = (fn: () => void) => fn();

    await app.init();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.dailyDropPrompt).toEqual({ text: 'Prompt text', answered: false });
  });
});
