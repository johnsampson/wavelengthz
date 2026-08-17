import { describe, it, expect } from 'vitest';
import {
  hookOffsetMs,
  createPlayProgress,
  isTrackEnd,
  isDeviceGoneEnd,
  radioAdvanceDelayMs,
  RADIO_ADVANCE_GRACE_MS,
  RADIO_MAX_CONSECUTIVE,
  PLAY_THRESHOLD_MS,
} from '../../public/playHeuristics.js';

describe('hookOffsetMs', () => {
  it('starts a normal-length track partway in, not at 0:00', () => {
    const threeMinutes = 180_000;
    expect(hookOffsetMs(threeMinutes)).toBe(36_000); // 20%
  });

  it('caps how deep it will skip on a long track', () => {
    // 20% of 9 minutes is nearly 2 minutes -- past "the hook" and into
    // "somewhere random in the middle".
    expect(hookOffsetMs(540_000)).toBe(45_000);
  });

  it('starts a short track at the beginning -- there is no intro worth skipping', () => {
    expect(hookOffsetMs(45_000)).toBe(0);
    expect(hookOffsetMs(59_999)).toBe(0);
  });

  it('never skips so far that a full threshold-length listen is impossible', () => {
    // The optimization must never make a counted stream *less* achievable.
    for (const duration of [60_000, 65_000, 90_000, 120_000, 200_000, 600_000]) {
      const offset = hookOffsetMs(duration);
      expect(duration - offset).toBeGreaterThanOrEqual(PLAY_THRESHOLD_MS);
    }
  });

  it('falls back to 0 for an unknown or nonsense duration', () => {
    expect(hookOffsetMs(null)).toBe(0);
    expect(hookOffsetMs(undefined)).toBe(0);
    expect(hookOffsetMs(0)).toBe(0);
    expect(hookOffsetMs(-1000)).toBe(0);
    expect(hookOffsetMs(NaN)).toBe(0);
    expect(hookOffsetMs(Infinity)).toBe(0);
    expect(hookOffsetMs('180000' as any)).toBe(0);
  });

  it('always returns a whole number of milliseconds', () => {
    expect(Number.isInteger(hookOffsetMs(123_457))).toBe(true);
  });
});

describe('createPlayProgress', () => {
  /** Controllable clock, so elapsed time is asserted rather than slept through. */
  function fakeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }

  it('accumulates playing time while playing', () => {
    const clock = fakeClock();
    const p = createPlayProgress(clock.now);
    p.start();

    clock.advance(10_000);

    expect(p.playedMs()).toBe(10_000);
    expect(p.remainingToThresholdMs()).toBe(20_000);
  });

  it('stops accumulating while paused, and resumes from where it left off', () => {
    const clock = fakeClock();
    const p = createPlayProgress(clock.now);
    p.start();

    clock.advance(10_000);
    p.pause();
    clock.advance(60_000); // paused for a minute -- must not count
    expect(p.playedMs()).toBe(10_000);

    p.resume();
    clock.advance(5_000);
    expect(p.playedMs()).toBe(15_000);
  });

  it('reports the threshold met only after enough real playing time', () => {
    const clock = fakeClock();
    const p = createPlayProgress(clock.now);
    p.start();

    clock.advance(PLAY_THRESHOLD_MS - 1);
    expect(p.remainingToThresholdMs()).toBe(1);

    clock.advance(1);
    expect(p.remainingToThresholdMs()).toBe(0);
  });

  it('never reports negative remaining time once well past the threshold', () => {
    const clock = fakeClock();
    const p = createPlayProgress(clock.now);
    p.start();
    clock.advance(PLAY_THRESHOLD_MS * 5);
    expect(p.remainingToThresholdMs()).toBe(0);
  });

  it('ignores a redundant resume while already playing', () => {
    const clock = fakeClock();
    const p = createPlayProgress(clock.now);
    p.start();
    clock.advance(5_000);

    p.resume(); // no-op -- must not restart the segment and lose 5s
    clock.advance(5_000);

    expect(p.playedMs()).toBe(10_000);
  });

  it('ignores a redundant pause while already paused', () => {
    const clock = fakeClock();
    const p = createPlayProgress(clock.now);
    p.start();
    clock.advance(5_000);
    p.pause();

    clock.advance(1_000);
    p.pause(); // no-op -- must not double-count anything

    expect(p.playedMs()).toBe(5_000);
  });

  it('resets accumulated time when a new play starts', () => {
    const clock = fakeClock();
    const p = createPlayProgress(clock.now);
    p.start();
    clock.advance(20_000);

    p.start(); // different track
    expect(p.playedMs()).toBe(0);
    expect(p.remainingToThresholdMs()).toBe(PLAY_THRESHOLD_MS);
  });
});

describe('isTrackEnd', () => {
  const at = (position: number, paused: boolean, spotifyId = 'sp1') => ({ spotifyId, position, paused });

  it('detects a track running out: was playing and progressing, now paused at 0', () => {
    expect(isTrackEnd(at(178_000, false), at(0, true))).toBe(true);
  });

  it('does not mistake an ordinary pause mid-track for an ending', () => {
    expect(isTrackEnd(at(45_000, false), at(45_000, true))).toBe(false);
  });

  it('does not mistake a pause at the very start for an ending', () => {
    // Position never advanced, so there was nothing to finish.
    expect(isTrackEnd(at(0, false), at(0, true))).toBe(false);
  });

  it('does not fire when a different track is now loaded -- that is a swap', () => {
    expect(isTrackEnd(at(178_000, false, 'sp1'), at(0, true, 'sp2'))).toBe(false);
  });

  it('does not fire on a seek back to the start while still playing', () => {
    expect(isTrackEnd(at(90_000, false), at(0, false))).toBe(false);
  });

  it('does not fire without a previous snapshot to compare against', () => {
    expect(isTrackEnd(null, at(0, true))).toBe(false);
    expect(isTrackEnd(at(90_000, false), null)).toBe(false);
  });

  it('keeps the consecutive-autoplay ceiling in place', () => {
    // The guardrail against unattended playback racking up plays nobody
    // asked for -- see its comment in playHeuristics.js.
    expect(RADIO_MAX_CONSECUTIVE).toBeGreaterThan(0);
    expect(RADIO_MAX_CONSECUTIVE).toBeLessThanOrEqual(30);
  });
});

describe('radioAdvanceDelayMs', () => {
  it('schedules for the time actually left in the track, plus a little grace', () => {
    expect(radioAdvanceDelayMs(150_000, 180_000)).toBe(30_000 + RADIO_ADVANCE_GRACE_MS);
  });

  it('accounts for a hook-offset start rather than assuming playback began at 0:00', () => {
    // Started 36s in on a 3-minute track: 144s left, not 180s. Getting this
    // wrong would advance a full 36 seconds late, every single track.
    expect(radioAdvanceDelayMs(36_000, 180_000)).toBe(144_000 + RADIO_ADVANCE_GRACE_MS);
  });

  it('gives up rather than guessing when the duration is unknown', () => {
    // A track stored before migrations/0022 has no duration. Radio simply
    // does not advance on the clock for it -- isTrackEnd is still the backup.
    expect(radioAdvanceDelayMs(10_000, null as any)).toBeNull();
    expect(radioAdvanceDelayMs(10_000, undefined as any)).toBeNull();
    expect(radioAdvanceDelayMs(10_000, 0)).toBeNull();
    expect(radioAdvanceDelayMs(10_000, NaN)).toBeNull();
  });

  it('gives up on a nonsense position rather than arming a bogus timer', () => {
    expect(radioAdvanceDelayMs(-1, 180_000)).toBeNull();
    expect(radioAdvanceDelayMs(NaN, 180_000)).toBeNull();
  });

  it('returns null once position is already at or past the end', () => {
    expect(radioAdvanceDelayMs(180_000, 180_000)).toBeNull();
    expect(radioAdvanceDelayMs(200_000, 180_000)).toBeNull();
  });

  it('leaves enough grace that a clean SDK ending wins the race', () => {
    // The timer is the reliable signal, but the SDK's own ending -- when it
    // comes -- is more precise. Grace exists so it gets there first.
    expect(RADIO_ADVANCE_GRACE_MS).toBeGreaterThan(0);
    expect(RADIO_ADVANCE_GRACE_MS).toBeLessThanOrEqual(3000);
  });
});

describe('isDeviceGoneEnd', () => {
  it('treats a null state as an ending when the track had been progressing', () => {
    // The regression this whole fix exists for: the SDK emits a null state
    // ("device no longer active") when a single-uri context runs out, and
    // discarding it meant radio never advanced in a real session.
    expect(isDeviceGoneEnd({ spotifyId: 'sp1', position: 178_000, paused: false })).toBe(true);
  });

  it('does not fire when nothing had played yet', () => {
    expect(isDeviceGoneEnd({ spotifyId: 'sp1', position: 0, paused: false })).toBe(false);
  });

  it('does not fire without a snapshot to judge against', () => {
    expect(isDeviceGoneEnd(null)).toBe(false);
    expect(isDeviceGoneEnd(undefined)).toBe(false);
  });
});
