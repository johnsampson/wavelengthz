export interface MusicProfile {
  topArtists: Array<{ id: string; rank: number }>;
  topGenres: string[];
}

export interface BlendedScoreInput {
  spotifyOverlap: number;
  musicSwipeOverlap: number;
  mutualInterestBoost: number;
  proximityScore: number;
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function proximityScore(distanceKm: number, maxDistanceKm: number): number {
  if (distanceKm > maxDistanceKm) return 0;
  if (maxDistanceKm === 0) return distanceKm === 0 ? 1 : 0;
  return 1 - distanceKm / maxDistanceKm;
}

export function bucketedDistanceLabel(distanceKm: number): string {
  const miles = distanceKm * 0.621371;
  if (miles < 1) return '<1 mile away';
  return `${Math.round(miles)} miles away`;
}

function rankWeights(items: Array<{ id: string; rank: number }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(item.id, 1 / item.rank);
  return map;
}

export function weightedOverlap(
  a: Array<{ id: string; rank: number }>,
  b: Array<{ id: string; rank: number }>
): number {
  const wa = rankWeights(a);
  const wb = rankWeights(b);
  const ids = new Set([...wa.keys(), ...wb.keys()]);
  let numerator = 0;
  let denominator = 0;
  for (const id of ids) {
    const va = wa.get(id) ?? 0;
    const vb = wb.get(id) ?? 0;
    numerator += Math.min(va, vb);
    denominator += Math.max(va, vb);
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function spotifyOverlap(a: MusicProfile, b: MusicProfile): number {
  const artistScore = weightedOverlap(a.topArtists, b.topArtists);
  const genreScore = jaccard(new Set(a.topGenres), new Set(b.topGenres));
  return (artistScore + genreScore) / 2;
}

export function computeBlendedScore(input: BlendedScoreInput): number {
  return (
    0.35 * input.spotifyOverlap +
    0.3 * input.musicSwipeOverlap +
    0.15 * input.mutualInterestBoost +
    0.2 * input.proximityScore
  );
}
