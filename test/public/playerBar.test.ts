import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  pickMode,
  renderPlayerChromeHtml,
  trackMatches,
  isCurrentTrack,
  like,
  play,
  hide,
  onNowPlayingChange,
  seekTargetMs,
  seekStepTargetMs,
  formatTime,
  SEEK_STEP_MS,
  SWIPE_REVEAL_PX,
  clampRevealOffset,
  shouldSnapOpen,
  _setCurrentTrackForTests,
  _resetForTests,
  _playTrackingStateForTests,
  _currentTrackLikedForTests,
} from '../../public/playerBar.js';
import { showToast, showErrorToast } from '../../public/toast.js';
import { checkPlayerAvailability, playTrack } from '../../public/wavelengthzPlayer.js';

vi.mock('../../public/wavelengthzPlayer.js', () => ({
  checkPlayerAvailability: vi.fn(),
  playTrack: vi.fn(),
  pausePlayback: vi.fn(),
  resumePlayback: vi.fn(),
  seekTo: vi.fn(),
  onStateChange: vi.fn(),
}));
vi.mock('../../public/toast.js', () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }));

beforeEach(() => {
  _resetForTests();
  vi.mocked(showToast).mockClear();
  vi.mocked(showErrorToast).mockClear();
});

describe('pickMode', () => {
  it('picks sdk when the Wavelengthz Player is available', () => {
    expect(pickMode({ available: true, accessToken: 'tok' })).toBe('sdk');
  });

  it('picks iframe (Basic player) when unavailable -- Free tier, or not re-authorized', () => {
    expect(pickMode({ available: false })).toBe('iframe');
  });

  it('picks iframe for a missing/undefined availability result rather than throwing', () => {
    expect(pickMode(undefined)).toBe('iframe');
  });
});

describe('trackMatches', () => {
  it('matches by spotifyId', () => {
    expect(trackMatches('trk1', { spotifyId: 'trk1', name: 'Song' })).toBe(true);
  });

  it('does not match a different spotifyId', () => {
    expect(trackMatches('trk1', { spotifyId: 'trk2', name: 'Other Song' })).toBe(false);
  });

  it('does not match when nothing is currently playing', () => {
    expect(trackMatches('trk1', null)).toBe(false);
  });
});

describe('renderPlayerChromeHtml', () => {
  it('renders nothing when no track is current', () => {
    expect(renderPlayerChromeHtml({ currentTrack: null, mode: null, sdkState: null })).toBe('');
  });

  it('renders a neutral loading state (no play/pause, no Basic player badge) while mode is still resolving', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', name: 'Valborg', artistName: 'Vintersorg', imageUrl: 'https://img.example/a.jpg' },
      mode: null,
      sdkState: null,
    });

    expect(html).toContain('Valborg');
    expect(html).toContain('Vintersorg');
    expect(html).toContain('data-action="hide"');
    expect(html).not.toContain('data-action="toggle"');
    expect(html).not.toContain('Basic player');
  });

  it('renders the sdk chrome with a play button and 0% progress before any state event has arrived', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', name: 'Valborg', imageUrl: 'https://img.example/a.jpg' },
      mode: 'sdk',
      sdkState: null,
    });

    expect(html).toContain('Valborg');
    expect(html).toContain('https://img.example/a.jpg');
    expect(html).toContain('aria-label="Play"');
    expect(html).toContain('width:0%');
    expect(html).not.toContain('Basic player');
  });

  it('renders the artist name alongside the track name when present', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', name: 'Valborg', artistName: 'Vintersorg', imageUrl: '' },
      mode: 'sdk',
      sdkState: null,
    });

    expect(html).toContain('Vintersorg');
  });

  it('omits the artist-name line entirely when there is none', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', name: 'Valborg', artistName: null, imageUrl: '' },
      mode: 'sdk',
      sdkState: null,
    });

    // Only one marquee wrapper -- the track name's -- not a second empty one.
    expect(html.match(/data-marquee-text/g)?.length).toBe(1);
  });

  it('wraps the track name in a marquee span so it can be auto-scrolled when truncated', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', name: 'Valborg', imageUrl: '' },
      mode: 'sdk',
      sdkState: null,
    });

    expect(html).toContain('data-marquee');
    expect(html).toContain('data-marquee-text');
  });

  it('shows a like button when the track carries an id to swipe against', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', id: 'catalog-trk1', name: 'Valborg', imageUrl: '' },
      mode: 'sdk',
      sdkState: null,
    });

    expect(html).toContain('data-action="like"');
  });

  it('omits the like button when the track has no id at all', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', name: 'Valborg', imageUrl: '' },
      mode: 'sdk',
      sdkState: null,
    });

    expect(html).not.toContain('data-action="like"');
  });

  // Issue #145 (Round 7) item 4: "a circled white stroke icon to mean
  // liked" -- same ring-2 ring-white convention artist.html's like buttons
  // already use.
  it('shows the like button unringed and labeled "Like this track" when not liked', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', id: 'catalog-trk1', name: 'Valborg', imageUrl: '' },
      mode: 'sdk',
      sdkState: null,
      liked: false,
    });

    expect(html).toContain('aria-label="Like this track"');
    expect(html).not.toContain('ring-2 ring-white');
  });

  it('rings the like button white and relabels it "Liked" once liked', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', id: 'catalog-trk1', name: 'Valborg', imageUrl: '' },
      mode: 'sdk',
      sdkState: null,
      liked: true,
    });

    expect(html).toContain('aria-label="Liked"');
    expect(html).toContain('ring-2 ring-white');
  });

  it('renders the sdk chrome with a pause button and the live progress percentage once playing', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', name: 'Valborg', imageUrl: 'https://img.example/a.jpg' },
      mode: 'sdk',
      sdkState: { paused: false, position: 30000, duration: 120000 },
    });

    expect(html).toContain('aria-label="Pause"');
    expect(html).toContain('width:25%');
  });

  it('renders the amber Basic player badge for iframe mode, with no play/pause button (the embed owns that)', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', name: 'Valborg', imageUrl: 'https://img.example/a.jpg' },
      mode: 'iframe',
      sdkState: null,
    });

    expect(html).toContain('Basic player');
    expect(html).not.toContain('data-action="toggle"');
    expect(html).toContain('data-action="hide"'); // close button is still present
  });

  it('escapes a track name containing HTML-special characters instead of injecting it raw', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', name: '<script>alert(1)</script> & "quoted"', imageUrl: '' },
      mode: 'iframe',
      sdkState: null,
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;quoted&quot;');
  });

  // Swipe-left-to-reveal-trash (issue #108): every mode's content is wrapped
  // in the same swipe-content/trash-button pair, so these run once against
  // the sdk branch rather than duplicating across all three modes.
  it('wraps the content in a closed (translateX 0) swipe reveal by default', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', name: 'Valborg', imageUrl: '' },
      mode: 'sdk',
      sdkState: null,
    });

    expect(html).toContain('data-swipe-content');
    expect(html).toContain('transform:translateX(0px)');
  });

  it('renders the swipe content already snapped open when revealed is true', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', name: 'Valborg', imageUrl: '' },
      mode: 'sdk',
      sdkState: null,
      revealed: true,
    });

    expect(html).toContain(`transform:translateX(-${SWIPE_REVEAL_PX}px)`);
  });

  it('renders a trash-can action behind the content, in addition to the existing close button', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: { spotifyId: 'trk1', name: 'Valborg', imageUrl: '' },
      mode: 'sdk',
      sdkState: null,
    });

    // Both the always-visible ✕ close button and the trash-can revealed by
    // a swipe call hide() -- same action, two affordances.
    expect(html.match(/data-action="hide"/g)?.length).toBe(2);
  });
});

describe('clampRevealOffset', () => {
  it('clamps a leftward drag from closed to the reveal width', () => {
    expect(clampRevealOffset(0, -30)).toBe(-30);
    expect(clampRevealOffset(0, -1000)).toBe(-SWIPE_REVEAL_PX);
  });

  it('never reveals on a rightward drag from closed', () => {
    expect(clampRevealOffset(0, 50)).toBe(0);
  });

  it('clamps a drag starting from an already-revealed position back toward closed', () => {
    expect(clampRevealOffset(-SWIPE_REVEAL_PX, 20)).toBe(-SWIPE_REVEAL_PX + 20);
    expect(clampRevealOffset(-SWIPE_REVEAL_PX, 1000)).toBe(0);
  });
});

describe('shouldSnapOpen', () => {
  it('snaps open once the drag passes the threshold ratio of the reveal width', () => {
    expect(shouldSnapOpen(-SWIPE_REVEAL_PX * 0.5)).toBe(true);
    expect(shouldSnapOpen(-SWIPE_REVEAL_PX * 0.2)).toBe(false);
  });

  it('treats a barely-open drag as a spring back to closed', () => {
    expect(shouldSnapOpen(-1)).toBe(false);
    expect(shouldSnapOpen(0)).toBe(false);
  });
});

describe('like', () => {
  it('does nothing when no track is current', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await like();

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does nothing when the current track has no id to swipe against', async () => {
    _setCurrentTrackForTests({ spotifyId: 'sp1', name: 'Song', imageUrl: '' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await like();

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('right-swipes the current track and confirms via toast', async () => {
    _setCurrentTrackForTests({ spotifyId: 'sp1', id: 'trk1', name: 'Song', imageUrl: '' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await like();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/swipe/music',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ item_type: 'track', item_id: 'trk1', direction: 'right' }) })
    );
    expect(showToast).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // Issue #145 (Round 7) item 4: the button's own state (not just the
  // toast) reflects a successful like.
  it('marks the current track liked on success', async () => {
    _setCurrentTrackForTests({ spotifyId: 'sp1', id: 'trk1', name: 'Song', imageUrl: '' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    expect(_currentTrackLikedForTests()).toBe(false);
    await like();

    expect(_currentTrackLikedForTests()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('growls an error toast when the swipe request fails', async () => {
    _setCurrentTrackForTests({ spotifyId: 'sp1', id: 'trk1', name: 'Song', imageUrl: '' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    await like();

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('like'));
    vi.unstubAllGlobals();
  });

  it('does not mark the track liked when the swipe request fails', async () => {
    _setCurrentTrackForTests({ spotifyId: 'sp1', id: 'trk1', name: 'Song', imageUrl: '' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    await like();

    expect(_currentTrackLikedForTests()).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('onNowPlayingChange', () => {
  // isCurrentTrack() reads this module's own state, which a page's Alpine
  // component has no way to notice changing on its own -- most visibly when
  // radio auto-advances to the next track while the listener is looking at
  // an unrelated track-card page. Every page subscribes here and bumps a
  // counter of its own to give Alpine something to actually re-run its
  // isCurrentTrack bindings on (see e.g. artist.js's nowPlayingTick).
  //
  // document.getElementById stubbed to return null throughout -- both
  // renderChrome() and hideIframe() bail out immediately on a missing root,
  // which is exactly what lets play()/hide() run to completion in this
  // DOM-less test pool.
  beforeEach(() => {
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  });

  it('notifies subscribers when a new track starts playing', async () => {
    const listener = vi.fn();
    const unsubscribe = onNowPlayingChange(listener);

    await play({ spotifyId: 'sp1', id: 't1', name: 'Song' });

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    vi.unstubAllGlobals();
  });

  it('notifies subscribers when hide() clears the current track', async () => {
    _setCurrentTrackForTests({ spotifyId: 'sp1', id: 't1', name: 'Song' });
    const listener = vi.fn();
    const unsubscribe = onNowPlayingChange(listener);

    await hide();

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    vi.unstubAllGlobals();
  });

  it('stops notifying once unsubscribed', async () => {
    const listener = vi.fn();
    const unsubscribe = onNowPlayingChange(listener);
    unsubscribe();

    await play({ spotifyId: 'sp1', id: 't1', name: 'Song' });

    expect(listener).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// Issue #127: "there's still a player issue when you navigate around the
// site, on occasion... it opens multiple players both the main player and
// the basic player and it doesn't work." startPlayback() has two real await
// points (checkPlayerAvailability, the actual Spotify play call), so a
// second play() landing before the first's awaits settle used to let
// whichever call's continuation ran LAST win, regardless of which track was
// actually tapped most recently -- including an older call's playTrack()
// failure falling through to showIframe() and overwriting a newer call's
// already-successful mode = 'sdk'. playToken guards against exactly this.
describe('the playToken race guard (issue #127)', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    vi.mocked(checkPlayerAvailability).mockResolvedValue({ available: true, accessToken: 'tok' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a stale call\'s late playTrack() failure does not overwrite a newer call\'s successful sdk mode', async () => {
    let resolveA: (v: boolean) => void;
    vi.mocked(playTrack).mockImplementation((spotifyId: string) => {
      if (spotifyId === 'spA') return new Promise<boolean>((r) => { resolveA = r; });
      return Promise.resolve(true);
    });

    // A starts first and is let through to its own in-flight playTrack()
    // call (the SECOND guard checkpoint, right after the Spotify play
    // request) before B starts -- exactly like a fast double-tap or radio
    // advancing right as a new tap lands while the previous play request is
    // still in flight. checkPlayerAvailability() resolves in exactly one
    // microtask tick (it's a mockResolvedValue), so a single `await
    // Promise.resolve()` here lands after A's continuation runs but before
    // B exists at all.
    const playA = play({ spotifyId: 'spA', id: 'a', name: 'Song A' });
    await Promise.resolve();
    expect(playTrack).toHaveBeenCalledWith('spA', expect.anything());

    // B starts after A is already mid-flight and succeeds immediately.
    const playB = play({ spotifyId: 'spB', id: 'b', name: 'Song B' });
    await playB;
    expect(_playTrackingStateForTests().mode).toBe('sdk');
    expect(isCurrentTrack('spB')).toBe(true);

    // A's play call finally resolves -- late, and it FAILED. Without the
    // guard this falls through to mode = 'iframe' + showIframe('spA'),
    // clobbering B's already-correct state with a Basic-player view of the
    // wrong (superseded) track while the SDK keeps actually playing B.
    resolveA!(false);
    await playA;

    expect(_playTrackingStateForTests().mode).toBe('sdk');
    expect(isCurrentTrack('spB')).toBe(true);
  });

  it('a stale call\'s late playTrack() success does not re-render over a newer call', async () => {
    let resolveA: (v: boolean) => void;
    vi.mocked(playTrack).mockImplementation((spotifyId: string) => {
      if (spotifyId === 'spA') return new Promise<boolean>((r) => { resolveA = r; });
      return Promise.resolve(true);
    });

    const playA = play({ spotifyId: 'spA', id: 'a', name: 'Song A' });
    await Promise.resolve();
    expect(playTrack).toHaveBeenCalledWith('spA', expect.anything());

    const playB = play({ spotifyId: 'spB', id: 'b', name: 'Song B' });
    await playB;

    // A's play call also succeeds, but late and stale -- must not be
    // treated as the current track even though Spotify did start it.
    resolveA!(true);
    await playA;

    expect(isCurrentTrack('spB')).toBe(true);
    expect(isCurrentTrack('spA')).toBe(false);
  });

  it('hide() invalidates an in-flight startPlayback so it can never re-show the player after an explicit close', async () => {
    let resolveA: (v: boolean) => void;
    vi.mocked(playTrack).mockImplementation(() => new Promise<boolean>((r) => { resolveA = r; }));

    // Let A reach its own in-flight playTrack() call before the explicit
    // close comes in, same as the two tests above -- the close needs to win
    // even against a play that's already made the real Spotify request, not
    // just one still waiting on checkPlayerAvailability().
    const playA = play({ spotifyId: 'spA', id: 'a', name: 'Song A' });
    await Promise.resolve();
    expect(playTrack).toHaveBeenCalledWith('spA', expect.anything());

    await hide();
    resolveA!(true);
    await playA;

    expect(isCurrentTrack('spA')).toBe(false);
  });
});

describe('seekTargetMs', () => {
  const rect = { left: 100, width: 200 } as any;

  it('maps a click to the matching position in the track', () => {
    expect(seekTargetMs(200, rect, 180_000)).toBe(90_000); // halfway
    expect(seekTargetMs(150, rect, 180_000)).toBe(45_000); // quarter
  });

  it('clamps a click that lands just outside the bar', () => {
    // The hit area is padded taller than the bar, so an edge tap can be a
    // pixel or two outside it. Seeking negative or past the end is never
    // what was meant.
    expect(seekTargetMs(90, rect, 180_000)).toBe(0);
    expect(seekTargetMs(310, rect, 180_000)).toBe(180_000);
  });

  it('refuses to guess when the duration is unknown', () => {
    expect(seekTargetMs(200, rect, null as any)).toBeNull();
    expect(seekTargetMs(200, rect, 0)).toBeNull();
    expect(seekTargetMs(200, rect, NaN)).toBeNull();
  });

  it('refuses to divide by a zero-width bar', () => {
    // Happens if the bar is measured while hidden -- a real case during the
    // router's page swap.
    expect(seekTargetMs(200, { left: 0, width: 0 } as any, 180_000)).toBeNull();
    expect(seekTargetMs(200, null as any, 180_000)).toBeNull();
  });

  it('always returns a whole number of milliseconds', () => {
    expect(Number.isInteger(seekTargetMs(173, rect, 187_333))).toBe(true);
  });
});

describe('seekStepTargetMs', () => {
  it('nudges forward and back by the step', () => {
    expect(seekStepTargetMs(60_000, SEEK_STEP_MS, 180_000)).toBe(65_000);
    expect(seekStepTargetMs(60_000, -SEEK_STEP_MS, 180_000)).toBe(55_000);
  });

  it('clamps at both ends of the track', () => {
    expect(seekStepTargetMs(2_000, -SEEK_STEP_MS, 180_000)).toBe(0);
    expect(seekStepTargetMs(178_000, SEEK_STEP_MS, 180_000)).toBe(180_000);
  });

  it('treats an unknown position as the start', () => {
    expect(seekStepTargetMs(undefined as any, SEEK_STEP_MS, 180_000)).toBe(5_000);
  });

  it('refuses to act without a duration', () => {
    expect(seekStepTargetMs(60_000, SEEK_STEP_MS, undefined as any)).toBeNull();
  });
});

describe('formatTime', () => {
  it('formats as m:ss with a padded seconds field', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(9_000)).toBe('0:09');
    expect(formatTime(65_000)).toBe('1:05');
    expect(formatTime(600_000)).toBe('10:00');
  });

  it('degrades to 0:00 rather than NaN for unusable input', () => {
    expect(formatTime(null as any)).toBe('0:00');
    expect(formatTime(-1)).toBe('0:00');
  });
});

describe('the seek control in rendered chrome', () => {
  const sdkTrack = { spotifyId: 'sp1', id: 't1', name: 'Song', artistName: 'Band', imageUrl: 'i' };

  it('exposes the progress bar as a real slider with the current position', () => {
    const html = renderPlayerChromeHtml({
      currentTrack: sdkTrack,
      mode: 'sdk',
      sdkState: { paused: false, position: 45_000, duration: 180_000 },
    });

    expect(html).toContain('data-action="seek"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuenow="45000"');
    expect(html).toContain('aria-valuemax="180000"');
    // Announced as time, not milliseconds.
    expect(html).toContain('0:45 of 3:00');
    // Focusable, or arrow-key seeking is unreachable.
    expect(html).toContain('tabindex="0"');
  });

  it('renders a zero-width bar rather than NaN before the first state arrives', () => {
    const html = renderPlayerChromeHtml({ currentTrack: sdkTrack, mode: 'sdk', sdkState: null });

    expect(html).toContain('width:0%');
    expect(html).not.toContain('NaN');
  });

  it('offers no seek control in iframe mode, which cannot be seeked', () => {
    const html = renderPlayerChromeHtml({ currentTrack: sdkTrack, mode: 'iframe', sdkState: null });

    expect(html).not.toContain('data-action="seek"');
  });
});
