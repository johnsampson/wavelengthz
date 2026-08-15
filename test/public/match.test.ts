import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMatchApp } from '../../public/match.js';
import { showErrorToast } from '../../public/toast.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
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
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const app = createMatchApp();

    await app.unmatch();

    expect(win.location.href).toBe('/matches');
    vi.unstubAllGlobals();
  });

  it('growls a toast and does not navigate when unmatch fails', async () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createMatchApp();

    await app.unmatch();

    expect(win.location.href).toBe('');
    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('unmatch'));
    vi.unstubAllGlobals();
  });
});
