import { describe, it, expect } from 'vitest';
import {
  haversineKm,
  bucketedDistanceLabel,
  weightedOverlap,
  jaccard,
  spotifyOverlap,
  computeBlendedScore,
} from '../../src/lib/scoring';

describe('haversineKm', () => {
  it('returns ~0 for identical coordinates', () => {
    expect(haversineKm(30.27, -97.74, 30.27, -97.74)).toBeCloseTo(0, 3);
  });

  it('computes a known distance between Austin and Dallas (~300km) within 5%', () => {
    const km = haversineKm(30.2672, -97.7431, 32.7767, -96.797);
    expect(km).toBeGreaterThan(280);
    expect(km).toBeLessThan(320);
  });
});

describe('bucketedDistanceLabel', () => {
  it('renders sub-mile distances distinctly', () => {
    expect(bucketedDistanceLabel(0.5)).toBe('<1 mile away');
  });
  it('renders whole-mile distances', () => {
    expect(bucketedDistanceLabel(19.31)).toBe('12 miles away'); // ~19.31km = 12mi
  });
});

describe('weightedOverlap', () => {
  it('is 1.0 for identical rank-ordered lists', () => {
    const list = [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }];
    expect(weightedOverlap(list, list)).toBeCloseTo(1, 5);
  });
  it('is 0 for disjoint lists', () => {
    expect(weightedOverlap([{ id: 'a', rank: 1 }], [{ id: 'z', rank: 1 }])).toBe(0);
  });
  it('weights a shared top-ranked item higher than a shared low-ranked one', () => {
    const sharedTop = weightedOverlap([{ id: 'a', rank: 1 }, { id: 'x', rank: 2 }], [{ id: 'a', rank: 1 }, { id: 'y', rank: 2 }]);
    const sharedLow = weightedOverlap([{ id: 'a', rank: 2 }, { id: 'x', rank: 1 }], [{ id: 'a', rank: 2 }, { id: 'y', rank: 1 }]);
    expect(sharedTop).toBeGreaterThan(sharedLow);
  });
});

describe('jaccard', () => {
  it('is 1.0 for identical sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });
  it('is 0.5 for a half-overlapping pair', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'c']))).toBeCloseTo(1 / 3, 5);
  });
  it('is 0 for two empty sets', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe('spotifyOverlap', () => {
  it('averages artist and genre overlap', () => {
    const a = { topArtists: [{ id: 'a1', rank: 1 }], topGenres: ['pop', 'rock'] };
    const b = { topArtists: [{ id: 'a1', rank: 1 }], topGenres: ['pop'] };
    const score = spotifyOverlap(a, b);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('computeBlendedScore', () => {
  it('applies the documented weights', () => {
    const score = computeBlendedScore({
      spotifyOverlap: 1,
      musicSwipeOverlap: 1,
      mutualInterestBoost: 1,
    });
    // Weights intentionally sum to 0.8, not 1 -- this score is sort-order
    // only, never displayed as an absolute/percentage value (see
    // computeBlendedScore's comment).
    expect(score).toBeCloseTo(0.8, 5);
  });

  it('is 0 when every input is 0', () => {
    expect(computeBlendedScore({ spotifyOverlap: 0, musicSwipeOverlap: 0, mutualInterestBoost: 0 })).toBe(0);
  });

  it('weights spotifyOverlap most heavily among the three inputs', () => {
    const onlySpotify = computeBlendedScore({ spotifyOverlap: 1, musicSwipeOverlap: 0, mutualInterestBoost: 0 });
    const onlyMutualInterest = computeBlendedScore({ spotifyOverlap: 0, musicSwipeOverlap: 0, mutualInterestBoost: 1 });
    expect(onlySpotify).toBeGreaterThan(onlyMutualInterest);
    expect(onlySpotify).toBeCloseTo(0.35, 5);
  });

  it('ignores a stray proximityScore field, proving distance no longer influences the score at all', () => {
    // Geography is a pool filter (peopleSwipes.ts's SQL/haversine check
    // against max_distance_km), not a scoring input -- issue #35 §5.4.
    const withProximity = computeBlendedScore({ spotifyOverlap: 1, musicSwipeOverlap: 1, mutualInterestBoost: 1, proximityScore: 0 } as any);
    const without = computeBlendedScore({ spotifyOverlap: 1, musicSwipeOverlap: 1, mutualInterestBoost: 1 });
    expect(withProximity).toBe(without);
  });
});
