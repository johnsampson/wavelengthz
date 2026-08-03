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

function parseProfileRow(row: { top_artists: string; top_genres: string }): MusicProfile {
  return {
    topArtists: JSON.parse(row.top_artists).map((a: any) => ({ id: a.artist_id, rank: a.rank })),
    topGenres: JSON.parse(row.top_genres),
  };
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/**
 * Batched form of `getMusicProfile` — one query for a whole candidate pool
 * instead of one per candidate. Users with no cached profile row are simply
 * absent from the returned map; callers should treat that as the same empty
 * profile `getMusicProfile` returns.
 */
export async function getMusicProfiles(db: D1Database, userIds: string[]): Promise<Map<string, MusicProfile>> {
  const profiles = new Map<string, MusicProfile>();
  if (userIds.length === 0) return profiles;

  const rows = await db
    .prepare(`SELECT user_id, top_artists, top_genres FROM music_profiles WHERE user_id IN (${placeholders(userIds.length)})`)
    .bind(...userIds)
    .all<{ user_id: string; top_artists: string; top_genres: string }>();

  for (const row of rows.results) profiles.set(row.user_id, parseProfileRow(row));
  return profiles;
}

/** Batched form of `getRightSwipedItemIds` — one query for a whole pool. */
export async function getRightSwipedItemIdsFor(db: D1Database, userIds: string[]): Promise<Map<string, Set<string>>> {
  const byUser = new Map<string, Set<string>>();
  if (userIds.length === 0) return byUser;

  const rows = await db
    .prepare(
      `SELECT user_id, item_id FROM music_swipes WHERE direction = 'right' AND user_id IN (${placeholders(userIds.length)})`
    )
    .bind(...userIds)
    .all<{ user_id: string; item_id: string }>();

  for (const row of rows.results) {
    let set = byUser.get(row.user_id);
    if (!set) {
      set = new Set<string>();
      byUser.set(row.user_id, set);
    }
    set.add(row.item_id);
  }
  return byUser;
}
