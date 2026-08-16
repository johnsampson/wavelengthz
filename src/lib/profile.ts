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
// across every track list on the page. artistName is null for a row stored
// before this field existed (an untouched pre-existing music_profiles row) --
// not re-fetched retroactively, just displayed without a subtitle until the
// next time this user's whole profile happens to be recomputed.
export interface DisplayMusicTrack extends DisplayMusicItem {
  spotifyId: string;
  artistName: string | null;
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
  const tracks: Array<{ track_id: string; rank: number; name: string; artistName?: string | null; imageUrl: string | null }> = JSON.parse(
    row.top_tracks
  );

  return {
    topGenres: JSON.parse(row.top_genres),
    topArtists: [...artists].sort(byRank).slice(0, DISPLAY_LIMIT).map((a) => ({ id: a.artist_id, name: a.name, imageUrl: a.imageUrl })),
    topTracks: [...tracks]
      .sort(byRank)
      .slice(0, DISPLAY_LIMIT)
      .map((t) => ({ id: t.track_id, spotifyId: t.track_id, name: t.name, artistName: t.artistName ?? null, imageUrl: t.imageUrl })),
  };
}

/**
 * Resolves users.anthem_track_id against an already-loaded topTracks list
 * (e.g. from getDisplayMusicProfile). Returns null both when no anthem is
 * set and when the chosen track has since fallen out of top_tracks on a
 * refresh -- there's no FK to enforce this, so a stale id is expected to
 * happen occasionally and just means "no anthem to show" rather than an error.
 */
export function pickAnthemTrack(topTracks: DisplayMusicTrack[], anthemTrackId: string | null): DisplayMusicTrack | null {
  if (!anthemTrackId) return null;
  return topTracks.find((t) => t.id === anthemTrackId) ?? null;
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

/**
 * Batched form of `pickAnthemTrack` — one query for a whole candidate pool
 * (GET /api/candidates/people) instead of one per candidate, and it never
 * even issues that one query when nobody in the batch has an anthem set,
 * which is the common case today. `users` only needs the two fields already
 * on hand from a `SELECT u.*` -- callers don't need a second lookup just to
 * build this list.
 */
export async function getAnthemTracksForUsers(
  db: D1Database,
  users: Array<{ id: string; anthem_track_id: string | null }>
): Promise<Map<string, DisplayMusicTrack>> {
  const anthems = new Map<string, DisplayMusicTrack>();
  const anthemByUserId = new Map(users.filter((u) => u.anthem_track_id).map((u) => [u.id, u.anthem_track_id!]));
  if (anthemByUserId.size === 0) return anthems;

  const userIds = [...anthemByUserId.keys()];
  const rows = await db
    .prepare(`SELECT user_id, top_tracks FROM music_profiles WHERE user_id IN (${placeholders(userIds.length)})`)
    .bind(...userIds)
    .all<{ user_id: string; top_tracks: string }>();

  for (const row of rows.results) {
    const tracks: Array<{ track_id: string; name: string; artistName?: string | null; imageUrl: string | null }> = JSON.parse(
      row.top_tracks
    );
    const topTracks = tracks.map((t) => ({
      id: t.track_id,
      spotifyId: t.track_id,
      name: t.name,
      artistName: t.artistName ?? null,
      imageUrl: t.imageUrl,
    }));
    const anthem = pickAnthemTrack(topTracks, anthemByUserId.get(row.user_id)!);
    if (anthem) anthems.set(row.user_id, anthem);
  }
  return anthems;
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
