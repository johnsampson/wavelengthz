import type { MusicProfile } from './scoring';

export async function getMusicProfile(db: D1Database, userId: string): Promise<MusicProfile> {
  const row = await db.prepare('SELECT top_artists, top_genres FROM music_profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ top_artists: string; top_genres: string }>();
  if (!row) return { topArtists: [], topGenres: [] };
  return {
    topArtists: JSON.parse(row.top_artists).map((a: any) => ({ id: a.artist_id, rank: a.rank })),
    topGenres: JSON.parse(row.top_genres),
  };
}

export async function getRightSwipedItemIds(db: D1Database, userId: string): Promise<Set<string>> {
  const rows = await db.prepare(`SELECT item_id FROM music_swipes WHERE user_id = ? AND direction = 'right'`)
    .bind(userId)
    .all<{ item_id: string }>();
  return new Set(rows.results.map((r) => r.item_id));
}
