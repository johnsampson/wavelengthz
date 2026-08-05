import type { MusicProfile } from './scoring';

const DISPLAY_LIMIT = 10;

export interface DisplayMusicItem {
  id: string;
  name: string;
  imageUrl: string | null;
}

// spotifyId is the real Spotify track id, for the embed player -- for
// topTracks it happens to equal `id` (this data is the user's raw cached
// Spotify "top tracks", never touching the artists/tracks catalog tables),
// but exposing it uniformly lets profile.html's player use one field name
// across every track list on the page.
export interface DisplayMusicTrack extends DisplayMusicItem {
  spotifyId: string;
}

export interface DisplayMusicProfile {
  topGenres: string[];
  topArtists: DisplayMusicItem[];
  topTracks: DisplayMusicTrack[];
}

/**
 * The user-facing counterpart to getMusicProfile/getMusicProfiles below,
 * which strip everything down to {id, rank} for scoring. This keeps
 * name/imageUrl (stored on the row since src/routes/me.ts's first fetch) so
 * profile pages can show "top on Spotify" without any extra Spotify calls or
 * shared-catalog lookup.
 */
export async function getDisplayMusicProfile(db: D1Database, userId: string): Promise<DisplayMusicProfile> {
  const row = await db.prepare('SELECT top_artists, top_tracks, top_genres FROM music_profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ top_artists: string; top_tracks: string; top_genres: string }>();
  if (!row) return { topGenres: [], topArtists: [], topTracks: [] };

  const byRank = (a: { rank: number }, b: { rank: number }) => a.rank - b.rank;

  const artists: Array<{ artist_id: string; rank: number; name: string; imageUrl: string | null }> = JSON.parse(row.top_artists);
  const tracks: Array<{ track_id: string; rank: number; name: string; imageUrl: string | null }> = JSON.parse(row.top_tracks);

  return {
    topGenres: JSON.parse(row.top_genres),
    topArtists: [...artists].sort(byRank).slice(0, DISPLAY_LIMIT).map((a) => ({ id: a.artist_id, name: a.name, imageUrl: a.imageUrl })),
    topTracks: [...tracks].sort(byRank).slice(0, DISPLAY_LIMIT).map((t) => ({ id: t.track_id, spotifyId: t.track_id, name: t.name, imageUrl: t.imageUrl })),
  };
}

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
