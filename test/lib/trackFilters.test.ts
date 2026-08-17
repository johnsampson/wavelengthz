import { describe, it, expect } from 'vitest';
import { isLiveTrackName } from '../../src/lib/trackFilters';

describe('isLiveTrackName', () => {
  it('detects the dash-suffix convention', () => {
    expect(isLiveTrackName('Enjoy the Silence - Live')).toBe(true);
    expect(isLiveTrackName('Enjoy the Silence – Live')).toBe(true); // en dash
    expect(isLiveTrackName('Enjoy the Silence — Live')).toBe(true); // em dash
    expect(isLiveTrackName('Enjoy the Silence - Live at Wembley 1990')).toBe(true);
  });

  it('detects the parenthetical convention', () => {
    expect(isLiveTrackName('Enjoy the Silence (Live)')).toBe(true);
    expect(isLiveTrackName('Enjoy the Silence (Live at Wembley 1990)')).toBe(true);
    expect(isLiveTrackName('Enjoy the Silence (Live Version)')).toBe(true);
  });

  it('detects the bracket convention', () => {
    expect(isLiveTrackName('Enjoy the Silence [Live From Glastonbury]')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isLiveTrackName('Enjoy the Silence - LIVE')).toBe(true);
    expect(isLiveTrackName('Enjoy the Silence (live)')).toBe(true);
  });

  it('does not flag "live" appearing as an ordinary word in the title', () => {
    // The exact false-positive risk this heuristic exists to avoid -- real
    // song titles about living, not live recordings.
    expect(isLiveTrackName('Live Forever')).toBe(false);
    expect(isLiveTrackName('Live and Let Die')).toBe(false);
    expect(isLiveTrackName("Stayin' Alive")).toBe(false);
    expect(isLiveTrackName('I Will Survive')).toBe(false);
  });

  it('does not flag "live" as a substring of another word', () => {
    expect(isLiveTrackName('Olive Tree')).toBe(false);
    expect(isLiveTrackName('Liverpool')).toBe(false);
    expect(isLiveTrackName('Delivered')).toBe(false);
  });

  it('does not flag an ordinary title containing a hyphen unrelated to live', () => {
    expect(isLiveTrackName('Sugar - Recut')).toBe(false);
    expect(isLiveTrackName('Song (Radio Edit)')).toBe(false);
    expect(isLiveTrackName('Song (Remastered 2015)')).toBe(false);
  });

  it('handles missing or empty input without throwing', () => {
    expect(isLiveTrackName(null)).toBe(false);
    expect(isLiveTrackName(undefined)).toBe(false);
    expect(isLiveTrackName('')).toBe(false);
  });
});
