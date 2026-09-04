import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPersonProfileApp } from '../../public/personProfile.js';
import { showErrorToast } from '../../public/toast.js';
import { play, togglePlayPause, isCurrentTrack, onNowPlayingChange } from '../../public/playerBar.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));
vi.mock('../../public/playerBar.js', () => ({
  play: vi.fn(),
  togglePlayPause: vi.fn(),
  isCurrentTrack: vi.fn(() => false),
  onNowPlayingChange: vi.fn(() => vi.fn()),
}));

function fakeWindow() {
  return { location: { search: '?id=u2', href: '' } };
}

function stubApi(handler: (path: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => handler(path)));
}

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
  vi.mocked(play).mockClear();
  vi.mocked(togglePlayPause).mockClear();
  vi.mocked(isCurrentTrack).mockReset().mockReturnValue(false);
  vi.mocked(onNowPlayingChange).mockReset().mockReturnValue(vi.fn());
});

describe('person profile page', () => {
  it('loads the profile and overlap on init', async () => {
    vi.stubGlobal('window', fakeWindow());
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path === '/api/people/u2/profile')
        return new Response(
          JSON.stringify({ profile: { displayName: 'Sam', photoUrls: [] }, overlap: { sharedArtists: [], sharedTracks: [], sharedGenres: [{ genre: 'indie' }] } }),
          { status: 200 }
        );
      return new Response('not found', { status: 404 });
    });
    const app = createPersonProfileApp();

    await app.init();

    expect(app.profile?.displayName).toBe('Sam');
    expect(app.overlap.sharedGenres).toEqual([{ genre: 'indie' }]);
    vi.unstubAllGlobals();
  });

  it('togglePlayer hands off a new track to the player bar', async () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createPersonProfileApp();

    await app.togglePlayer({ id: 't1', spotifyId: 'sp1', name: 'Song', artistName: 'Some Artist', imageUrl: 'img' });

    expect(play).toHaveBeenCalledWith({ spotifyId: 'sp1', id: 't1', name: 'Song', artistName: 'Some Artist', imageUrl: 'img' });
    vi.unstubAllGlobals();
  });

  it('toggleAnthem sets a new anthem', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const app = createPersonProfileApp();
    app.profile = { photoUrls: [], anthemTrack: null };

    await app.toggleAnthem({ id: 't1', name: 'Song' });

    expect(app.profile?.anthemTrack).toEqual({ id: 't1', name: 'Song' });
    vi.unstubAllGlobals();
  });

  it('toggleAnthem clears the anthem when tapped again on the already-set track', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const app = createPersonProfileApp();
    app.profile = { photoUrls: [], anthemTrack: { id: 't1' } };

    await app.toggleAnthem({ id: 't1', name: 'Song' });

    expect(app.profile?.anthemTrack).toBeNull();
    vi.unstubAllGlobals();
  });

  it('cycles the photo carousel forward and backward with wraparound', () => {
    vi.stubGlobal('window', fakeWindow());
    const app = createPersonProfileApp();
    app.profile = { photoUrls: ['a', 'b', 'c'] };
    app.carouselIndex = 2;

    app.nextPhoto();
    expect(app.carouselIndex).toBe(0);

    app.prevPhoto();
    expect(app.carouselIndex).toBe(2);
    vi.unstubAllGlobals();
  });

  // See artist.test.ts's identical case -- playerBar.js's own module state
  // (e.g. radio auto-advancing) is invisible to this page's isCurrentTrack
  // binding unless init() subscribes and bumps something reactive.
  it('subscribes to now-playing changes on init and bumps nowPlayingTick so isCurrentTrack re-evaluates', async () => {
    vi.stubGlobal('window', fakeWindow());
    stubApi((path) => (path === '/api/me' ? new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 }) : new Response('not found', { status: 404 })));
    let firePlayerChange: (() => void) | undefined;
    vi.mocked(onNowPlayingChange).mockImplementation((cb: () => void) => {
      firePlayerChange = cb;
      return vi.fn();
    });
    const app = createPersonProfileApp();

    await app.init();

    expect(onNowPlayingChange).toHaveBeenCalled();
    expect(app.nowPlayingTick).toBe(0);
    firePlayerChange?.();
    expect(app.nowPlayingTick).toBe(1);
    vi.mocked(isCurrentTrack).mockReturnValue(true);
    expect(app.isCurrentTrack('sp1')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('destroy() unsubscribes from now-playing changes', async () => {
    vi.stubGlobal('window', fakeWindow());
    stubApi((path) => (path === '/api/me' ? new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 }) : new Response('not found', { status: 404 })));
    const unsubscribe = vi.fn();
    vi.mocked(onNowPlayingChange).mockReturnValue(unsubscribe);
    const app = createPersonProfileApp();
    await app.init();

    app.destroy();

    expect(unsubscribe).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // Issue #173: reasonDialogSubmit is this page's wiring of the shared
  // reasonDialog.js picker (opened via openReportDialog() -- see
  // reasonDialog.test.ts for the picker's own open/select/validate logic).
  describe('reasonDialogSubmit (report)', () => {
    it('submits the report with reason and details, then closes the dialog', async () => {
      vi.stubGlobal('window', fakeWindow());
      const fetchMock = vi.fn(async (path: string, options?: any) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const app = createPersonProfileApp();
      app.reasonDialogOpen = true;

      await app.reasonDialogSubmit('report', 'harassment', 'kept messaging after I blocked once');

      const call = fetchMock.mock.calls.find((c) => c[0] === '/api/report');
      expect(JSON.parse((call![1] as any).body)).toEqual({ user_id: 'u2', reason: 'harassment', details: 'kept messaging after I blocked once' });
      expect(app.reasonDialogOpen).toBe(false);
      vi.unstubAllGlobals();
    });

    it('growls a toast and leaves the dialog open when the report fails', async () => {
      vi.stubGlobal('window', fakeWindow());
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
      const app = createPersonProfileApp();
      app.reasonDialogOpen = true;

      await app.reasonDialogSubmit('report', 'spam', undefined);

      expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('report'));
      expect(app.reasonDialogOpen).toBe(true);
      vi.unstubAllGlobals();
    });
  });
});
