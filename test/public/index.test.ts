import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDeckApp } from '../../public/index.js';
import { showErrorToast } from '../../public/toast.js';
import { play, togglePlayPause, isCurrentTrack } from '../../public/playerBar.js';
import { attachSwipeDeck } from '../../public/swipe.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));
vi.mock('../../public/playerBar.js', () => ({
  play: vi.fn(),
  togglePlayPause: vi.fn(),
  isCurrentTrack: vi.fn(() => false),
}));
vi.mock('../../public/swipe.js', () => ({ attachSwipeDeck: vi.fn() }));

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
    app.current = { anthemTrack: { spotifyId: 'sp1', name: 'Song', imageUrl: 'img' } };

    await app.toggleAnthem();

    expect(play).toHaveBeenCalledWith({ spotifyId: 'sp1', name: 'Song', imageUrl: 'img' });
  });

  it('toggleAnthem is a no-op when the current card has no anthem', async () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createDeckApp();
    app.current = { anthemTrack: null };

    await app.toggleAnthem();

    expect(play).not.toHaveBeenCalled();
    expect(togglePlayPause).not.toHaveBeenCalled();
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
});
