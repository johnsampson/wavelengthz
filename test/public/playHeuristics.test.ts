import { describe, it, expect } from 'vitest';
import { hookOffsetMs, createPlayProgress, PLAY_THRESHOLD_MS } from '../../public/playHeuristics.js';

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
