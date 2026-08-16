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
});
