import { describe, it, expect } from 'vitest';
import { pickMode, renderPlayerChromeHtml, trackMatches } from '../../public/playerBar.js';

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
