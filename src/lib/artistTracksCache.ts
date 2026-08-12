// Shared by src/routes/catalog.ts (reads on every artist-page load, writes
// once per completed live fetch) and src/lib/artistTrackBackfill.ts (the
// queue consumer that finishes what a first view's quick path deliberately
// left undone) -- one place owning the cache key format and TTL so the two
// paths can't drift out of sync with each other, the same reasoning as
// genreEnrichment.ts's shared enrichOneArtist.
export const ARTIST_TRACKS_CACHE_TTL_SECONDS = 600;

export function artistTracksCacheKey(spotifyArtistId: string, limit: number): string {
  return `artist-tracks-cache:${spotifyArtistId}:${limit}`;
}

// Returns null on both a genuine cache miss and a KV outage -- the caller's
// only correct response to either is the same (fall back to a live fetch),
// so there's no reason to make it distinguish the two.
export async function readArtistTracksCache(kv: KVNamespace, spotifyArtistId: string, limit: number): Promise<any[] | null> {
  try {
    const cached = await kv.get(artistTracksCacheKey(spotifyArtistId, limit));
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

export async function writeArtistTracksCache(kv: KVNamespace, spotifyArtistId: string, limit: number, tracks: any[]): Promise<void> {
  try {
    await kv.put(artistTracksCacheKey(spotifyArtistId, limit), JSON.stringify(tracks), {
      expirationTtl: ARTIST_TRACKS_CACHE_TTL_SECONDS,
    });
  } catch {
    // Non-fatal -- whichever caller just computed `tracks` live already has
    // its result either way; the only cost of a failed write is not caching
    // it for the next reader.
  }
}
