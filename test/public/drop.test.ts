import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDropApp } from '../../public/drop.js';
import { showErrorToast, showToast } from '../../public/toast.js';
import { play, togglePlayPause, isCurrentTrack, onNowPlayingChange } from '../../public/playerBar.js';
import { navigate } from '../../public/router.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn(), showToast: vi.fn() }));
vi.mock('../../public/playerBar.js', () => ({
  play: vi.fn(),
  togglePlayPause: vi.fn(),
  isCurrentTrack: vi.fn(() => false),
  onNowPlayingChange: vi.fn(() => vi.fn()),
}));
vi.mock('../../public/router.js', () => ({ navigate: vi.fn() }));

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(showErrorToast).mockClear();
  vi.mocked(showToast).mockClear();
  vi.mocked(play).mockClear();
  vi.mocked(togglePlayPause).mockClear();
  vi.mocked(isCurrentTrack).mockReset().mockReturnValue(false);
  vi.mocked(onNowPlayingChange).mockReset().mockReturnValue(vi.fn());
  vi.mocked(navigate).mockClear();
});

const PROMPT = { id: 'p1', text: "What's on repeat right now?", theme: 'Current mood' };

function stubApi(handlers: Record<string, any>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: any) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      const handler = handlers[path];
      if (!handler) throw new Error(`unexpected fetch ${path}`);
      const body = typeof handler === 'function' ? handler(init) : handler;
      if (body instanceof Response) return body;
      return new Response(JSON.stringify(body), { status: 200 });
    })
  );
  vi.stubGlobal('window', { location: { href: '', search: '' } });
}

describe('drop page', () => {
  it('loads today’s prompt and shows no answer yet, without fetching the browse list', async () => {
    const fetchAnswers = vi.fn();
    stubApi({
      '/api/daily-drop': { prompt: PROMPT, myAnswer: null, answerCount: 0 },
      '/api/daily-drop/answers': fetchAnswers,
    });
    const app = createDropApp();

    await app.init();

    expect(app.prompt).toEqual(PROMPT);
    expect(app.myAnswer).toBeNull();
    expect(app.answerCount).toBe(0);
    expect(app.loading).toBe(false);
    // Nothing to browse yet (answerCount 0) -- shouldn't fire a second
    // request nobody needs.
    expect(fetchAnswers).not.toHaveBeenCalled();
  });

  it('loads the browse list when the answer count is non-zero', async () => {
    stubApi({
      '/api/daily-drop': { prompt: PROMPT, myAnswer: null, answerCount: 2 },
      '/api/daily-drop/answers': { answers: [{ userId: 'u2', displayName: 'Sam', photoUrl: null, track: { name: 'Song', artistName: 'Artist', spotifyId: 'sp1', imageUrl: null } }] },
    });
    const app = createDropApp();

    await app.init();

    expect(app.answers).toHaveLength(1);
    expect(app.answers[0].displayName).toBe('Sam');
  });

  it('surfaces an error and stops loading when the prompt fetch fails', async () => {
    stubApi({ '/api/daily-drop': new Response('nope', { status: 500 }) });
    const app = createDropApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
  });

  it('searches only once the query is long enough (shouldSearch)', async () => {
    stubApi({ '/api/daily-drop': { prompt: PROMPT, myAnswer: null, answerCount: 0 } });
    const app = createDropApp();
    await app.init();

    app.searchQuery = 'ab';
    app.onSearchInput();
    expect(app.searchResults).toEqual([]);
  });

  it('submits a search result as the answer, reconstructing the raw Spotify shape', async () => {
    let sentBody: any = null;
    let analyticsBody: any = null;
    stubApi({
      '/api/daily-drop': { prompt: PROMPT, myAnswer: null, answerCount: 0 },
      '/api/daily-drop/answer': (init: any) => {
        sentBody = JSON.parse(init.body);
        return { myAnswer: { name: 'Song One', artistName: 'Artist One', spotifyId: 'sp1', imageUrl: 'https://i/1.jpg' } };
      },
      '/api/daily-drop/answers': { answers: [] },
      // Issue #170: Tier 1 event-coverage expansion.
      '/api/analytics/event': (init: any) => {
        analyticsBody = JSON.parse(init.body);
        return { ok: true };
      },
    });
    const app = createDropApp();
    await app.init();

    await app.selectAnswer({
      spotifyTrackId: 'sp1',
      name: 'Song One',
      artistName: 'Artist One',
      spotifyArtistId: 'sp-artist-1',
      imageUrl: 'https://i/1.jpg',
    });

    expect(sentBody.track).toEqual({
      id: 'sp1',
      name: 'Song One',
      artists: [{ id: 'sp-artist-1', name: 'Artist One' }],
      album: { images: [{ url: 'https://i/1.jpg' }] },
    });
    expect(app.myAnswer).toMatchObject({ name: 'Song One' });
    expect(app.answerCount).toBeGreaterThanOrEqual(1);
    expect(showToast).toHaveBeenCalled();
    // Issue #170: Tier 1 event-coverage expansion.
    expect(analyticsBody.eventType).toBe('daily_drop_answered');
  });

  it('shows a specific toast when Spotify cannot resolve the artist', async () => {
    stubApi({
      '/api/daily-drop': { prompt: PROMPT, myAnswer: null, answerCount: 0 },
      '/api/daily-drop/answer': () => {
        const res = new Response(JSON.stringify({ error: 'artist_unavailable' }), { status: 503 });
        return res;
      },
    });
    const app = createDropApp();
    await app.init();

    await app.selectAnswer({ spotifyTrackId: 'sp1', name: 'Song', artistName: 'Artist', spotifyArtistId: 'a1', imageUrl: null });

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('busy'));
  });

  it('guards against a double-tap submitting twice', async () => {
    let calls = 0;
    let resolveSecond: (() => void) | null = null;
    stubApi({
      '/api/daily-drop': { prompt: PROMPT, myAnswer: null, answerCount: 0 },
      '/api/daily-drop/answer': async () => {
        calls++;
        await new Promise<void>((resolve) => {
          resolveSecond = resolve;
        });
        return { myAnswer: null };
      },
      '/api/daily-drop/answers': { answers: [] },
    });
    const app = createDropApp();
    await app.init();

    const result = { spotifyTrackId: 'sp1', name: 'Song', artistName: 'Artist', spotifyArtistId: 'a1', imageUrl: null };
    const first = app.selectAnswer(result);
    const second = app.selectAnswer(result); // should no-op, submitting is already true
    resolveSecond!();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
  });

  it('plays a track via the persistent player bar, toggling if it is already current', async () => {
    stubApi({ '/api/daily-drop': { prompt: PROMPT, myAnswer: null, answerCount: 0 } });
    const app = createDropApp();
    await app.init();

    await app.playTrack({ spotifyId: 'sp1', name: 'Song', imageUrl: null });
    expect(play).toHaveBeenCalledWith({ spotifyId: 'sp1', name: 'Song', imageUrl: null });

    vi.mocked(isCurrentTrack).mockReturnValue(true);
    await app.playTrack({ spotifyId: 'sp1', name: 'Song', imageUrl: null });
    expect(togglePlayPause).toHaveBeenCalled();
  });

  it('navigates to the profile route when a browse card is tapped', async () => {
    stubApi({ '/api/daily-drop': { prompt: PROMPT, myAnswer: null, answerCount: 0 } });
    const app = createDropApp();
    await app.init();

    app.viewProfile('u2');
    expect(navigate).toHaveBeenCalledWith('/profile?id=u2');
  });

  // Radio auto-advancing to a new track (or any other page/tap starting one)
  // changes playerBar.js's own module state, which this page's isCurrentTrack
  // binding has no way to notice on its own -- see drop.js's nowPlayingTick
  // comment. init() must subscribe so Alpine has something to actually
  // re-run the answer rows' play/pause icons on.
  it('subscribes to now-playing changes on init and bumps nowPlayingTick so isCurrentTrack re-evaluates', async () => {
    stubApi({ '/api/daily-drop': { prompt: PROMPT, myAnswer: null, answerCount: 0 } });
    let firePlayerChange: (() => void) | undefined;
    vi.mocked(onNowPlayingChange).mockImplementation((cb: () => void) => {
      firePlayerChange = cb;
      return vi.fn();
    });
    const app = createDropApp();

    await app.init();

    expect(onNowPlayingChange).toHaveBeenCalled();
    expect(app.nowPlayingTick).toBe(0);
    firePlayerChange?.();
    expect(app.nowPlayingTick).toBe(1);
    vi.mocked(isCurrentTrack).mockReturnValue(true);
    expect(app.isCurrentTrack('sp1')).toBe(true);
  });

  it('destroy() unsubscribes from now-playing changes', async () => {
    stubApi({ '/api/daily-drop': { prompt: PROMPT, myAnswer: null, answerCount: 0 } });
    const unsubscribe = vi.fn();
    vi.mocked(onNowPlayingChange).mockReturnValue(unsubscribe);
    const app = createDropApp();
    await app.init();

    app.destroy();

    expect(unsubscribe).toHaveBeenCalled();
  });
});
