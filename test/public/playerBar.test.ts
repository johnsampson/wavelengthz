import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pickMode, renderPlayerChromeHtml, trackMatches, like, _setCurrentTrackForTests, _resetForTests } from '../../public/playerBar.js';
import { showToast, showErrorToast } from '../../public/toast.js';

vi.mock('../../public/wavelengthzPlayer.js', () => ({
  checkPlayerAvailability: vi.fn(),
  playTrack: vi.fn(),
  pausePlayback: vi.fn(),
  resumePlayback: vi.fn(),
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

  it('growls an error toast when the swipe request fails', async () => {
    _setCurrentTrackForTests({ spotifyId: 'sp1', id: 'trk1', name: 'Song', imageUrl: '' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    await like();

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('like'));
    vi.unstubAllGlobals();
  });
});
