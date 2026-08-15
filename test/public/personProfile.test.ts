import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPersonProfileApp } from '../../public/personProfile.js';
import { showErrorToast } from '../../public/toast.js';
import { play, togglePlayPause, isCurrentTrack } from '../../public/playerBar.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));
vi.mock('../../public/playerBar.js', () => ({
  play: vi.fn(),
  togglePlayPause: vi.fn(),
  isCurrentTrack: vi.fn(() => false),
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

    await app.togglePlayer({ spotifyId: 'sp1', name: 'Song', imageUrl: 'img' });

    expect(play).toHaveBeenCalledWith({ spotifyId: 'sp1', name: 'Song', imageUrl: 'img' });
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
});
