export interface MusicOverlap {
  sharedArtists: Array<{ id: string; name: string; imageUrl: string | null }>;
  // spotifyId is the real Spotify track id, for the embed player -- distinct
  // from `id` (our internal catalog UUID) since migrations/0002 obfuscated it.
  sharedTracks: Array<{ id: string; spotifyId: string; name: string; artistName: string; imageUrl: string | null }>;
  sharedGenres: Array<{ genre: string; myCount: number; theirCount: number }>;
}

export async function computeMusicOverlap(db: D1Database, userId: string, otherUserId: string): Promise<MusicOverlap> {
  const sharedArtists = await db
    .prepare(
      `SELECT a.id, a.name, a.image_url as image_url FROM music_swipes m1
       JOIN music_swipes m2 ON m2.item_type = m1.item_type AND m2.item_id = m1.item_id
       JOIN artists a ON a.id = m1.item_id
       WHERE m1.user_id = ? AND m2.user_id = ? AND m1.item_type = 'artist'
         AND m1.direction = 'right' AND m2.direction = 'right'`
    )
    .bind(userId, otherUserId)
    .all<{ id: string; name: string; image_url: string | null }>();

  const sharedTracks = await db
    .prepare(
      `SELECT t.id, t.spotify_id, t.name, ar.name as artist_name, t.album_image_url as image_url FROM music_swipes m1
       JOIN music_swipes m2 ON m2.item_type = m1.item_type AND m2.item_id = m1.item_id
       JOIN tracks t ON t.id = m1.item_id
       JOIN artists ar ON ar.id = t.artist_id
       WHERE m1.user_id = ? AND m2.user_id = ? AND m1.item_type = 'track'
         AND m1.direction = 'right' AND m2.direction = 'right'`
    )
    .bind(userId, otherUserId)
    .all<{ id: string; spotify_id: string; name: string; artist_name: string; image_url: string | null }>();

  const sharedGenres = await db
    .prepare(
      `SELECT g1.genre,
              (g1.artist_count + g1.track_count) as my_count,
              (g2.artist_count + g2.track_count) as their_count
       FROM user_genres g1
       JOIN user_genres g2 ON g2.genre = g1.genre
       WHERE g1.user_id = ? AND g2.user_id = ?
         AND (g1.artist_count + g1.track_count) > 0 AND (g2.artist_count + g2.track_count) > 0
       ORDER BY (my_count + their_count) DESC`
    )
    .bind(userId, otherUserId)
    .all<{ genre: string; my_count: number; their_count: number }>();

  return {
    sharedArtists: sharedArtists.results.map((a) => ({ id: a.id, name: a.name, imageUrl: a.image_url })),
    sharedTracks: sharedTracks.results.map((t) => ({ id: t.id, spotifyId: t.spotify_id, name: t.name, artistName: t.artist_name, imageUrl: t.image_url })),
    sharedGenres: sharedGenres.results.map((g) => ({ genre: g.genre, myCount: g.my_count, theirCount: g.their_count })),
  };
}
