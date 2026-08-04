// Maintains the catalog-wide `genres` table: how many artists/tracks in the
// whole catalog carry each genre. Call only after an insert actually landed
// (INSERT OR IGNORE's `changes > 0`) -- an already-known artist/track must
// not be double-counted just because it was looked up again.
export async function recordCatalogGenres(
  db: D1Database,
  genres: string[],
  itemType: 'artist' | 'track',
  now: number
): Promise<void> {
  const artistDelta = itemType === 'artist' ? 1 : 0;
  const trackDelta = itemType === 'track' ? 1 : 0;
  for (const genre of genres) {
    await db
      .prepare(
        `INSERT INTO genres (genre, artist_count, track_count, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(genre) DO UPDATE SET artist_count = artist_count + ?, track_count = track_count + ?, updated_at = ?`
      )
      .bind(genre, artistDelta, trackDelta, now, artistDelta, trackDelta, now)
      .run();
  }
}
