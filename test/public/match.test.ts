import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMatchApp } from '../../public/match.js';
import { showErrorToast } from '../../public/toast.js';
import { navigate } from '../../public/router.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));
vi.mock('../../public/router.js', () => ({ navigate: vi.fn() }));

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
  vi.mocked(navigate).mockClear();
});

// match.js reads `window.location.search` at object-construction time (not
// inside a method), so `window` has to be stubbed before createMatchApp()
// is ever called, in every test below.
function fakeWindow() {
  return { location: { search: '?id=m1', href: '' } };
}

describe('match detail', () => {
  it('loads the match and overlap on init', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
        return new Response(
          JSON.stringify({
            match: { id: 'm1', otherUserId: 'u2', otherDisplayName: 'Sam' },
            overlap: { sharedArtists: [], sharedTracks: [], sharedGenres: [{ genre: 'indie' }] },
          }),
          { status: 200 }
        );
      })
    );
    const app = createMatchApp();
    expect(app.matchId).toBe('m1');

    await app.init();

    expect(app.match).not.toBeNull();
    expect(app.match!.otherDisplayName).toBe('Sam');
    expect(app.overlap.sharedGenres).toEqual([{ genre: 'indie' }]);
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('navigates to /matches after a successful unmatch', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const app = createMatchApp();

    await app.unmatch();

    expect(navigate).toHaveBeenCalledWith('/matches');
    vi.unstubAllGlobals();
  });

  it('growls a toast and does not navigate when unmatch fails', async () => {
    vi.stubGlobal('window', fakeWindow());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createMatchApp();

    await app.unmatch();

    expect(navigate).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('unmatch'));
    vi.unstubAllGlobals();
  });

  // Issue #173: reasonDialogSubmit is this page's wiring of the shared
  // reasonDialog.js picker (opened via openReportDialog()/openBlockDialog()
  // -- see reasonDialog.test.ts for the picker's own open/select/validate
  // logic). match.js is the only host with a real `block` mode.
  describe('reasonDialogSubmit', () => {
    async function loadedApp(fetchMock: ReturnType<typeof vi.fn>) {
      vi.stubGlobal('window', fakeWindow());
      vi.stubGlobal('fetch', fetchMock);
      const app: any = createMatchApp();
      await app.init();
      return app;
    }

    it('block: submits reason/details, closes the dialog, and navigates to /matches', async () => {
      const fetchMock = vi.fn(async (path: string, options?: any) => {
        if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
        if (path === '/api/matches/m1') return new Response(JSON.stringify({ match: { id: 'm1', otherUserId: 'u2' }, overlap: { sharedArtists: [], sharedTracks: [], sharedGenres: [] } }), { status: 200 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      const app = await loadedApp(fetchMock);
      app.reasonDialogOpen = true;

      await app.reasonDialogSubmit('block', 'fake_profile', undefined);

      const call = fetchMock.mock.calls.find((c) => c[0] === '/api/block');
      expect(JSON.parse((call![1] as any).body)).toEqual({ user_id: 'u2', reason: 'fake_profile', details: undefined });
      expect(app.reasonDialogOpen).toBe(false);
      expect(navigate).toHaveBeenCalledWith('/matches');
      vi.unstubAllGlobals();
    });

    it('block: growls a toast, leaves the dialog open, and does not navigate when it fails', async () => {
      const fetchMock = vi.fn(async (path: string) => {
        if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
        if (path === '/api/matches/m1') return new Response(JSON.stringify({ match: { id: 'm1', otherUserId: 'u2' }, overlap: { sharedArtists: [], sharedTracks: [], sharedGenres: [] } }), { status: 200 });
        return new Response('nope', { status: 500 });
      });
      const app = await loadedApp(fetchMock);
      app.reasonDialogOpen = true;

      await app.reasonDialogSubmit('block', undefined, undefined);

      expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('block'));
      expect(app.reasonDialogOpen).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('report: submits reason/details and closes the dialog, without navigating', async () => {
      const fetchMock = vi.fn(async (path: string, options?: any) => {
        if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
        if (path === '/api/matches/m1') return new Response(JSON.stringify({ match: { id: 'm1', otherUserId: 'u2' }, overlap: { sharedArtists: [], sharedTracks: [], sharedGenres: [] } }), { status: 200 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      const app = await loadedApp(fetchMock);
      app.reasonDialogOpen = true;

      await app.reasonDialogSubmit('report', 'other', 'this is spam');

      const call = fetchMock.mock.calls.find((c) => c[0] === '/api/report');
      expect(JSON.parse((call![1] as any).body)).toEqual({ user_id: 'u2', reason: 'other', details: 'this is spam' });
      expect(app.reasonDialogOpen).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });
});
