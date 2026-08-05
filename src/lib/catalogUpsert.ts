import { genresToObject } from './genres';

// Shapes accepted straight from Spotify's Web API responses (search results,
// GET /v1/artists/:id, GET /v1/tracks/:id) -- callers pass those objects
// through as-is.
export interface SpotifyArtistLike {
  id: string;
  name: string;
  genres?: string[];
  images?: Array<{ url: string }>;
  popularity?: number;
}

export interface SpotifyTrackLike {
  id: string;
  name: string;
  album?: { images?: Array<{ url: string }> };
  preview_url?: string | null;
}

export interface UpsertResult {
  id: string; // internal UUID, never the Spotify id
  inserted: boolean;
}

// artists.id/tracks.id are app-generated UUIDs (see migrations/0002_*) --
// the real Spotify id lives in spotify_id, used only to dedupe re-imports of
// the same catalog item and to call Spotify's API. Always attempts the
// insert with a fresh UUID first (ON CONFLICT(spotify_id) DO NOTHING),
// falling back to a lookup only when that conflict actually fires -- this
// stays race-safe under concurrent requests the same way the old
// `INSERT OR IGNORE` on a deterministic (Spotify) id did.
export async function upsertArtist(
  db: D1Database,
  artist: SpotifyArtistLike,
  source: string,
  addedByUserId: string | null,
  now: number
): Promise<UpsertResult> {
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, image_url, popularity, source, added_by_user_id, approved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(spotify_id) DO NOTHING`
    )
    .bind(
      id,
      artist.id,
      artist.name,
      JSON.stringify(genresToObject(artist.genres)),
      artist.images?.[0]?.url ?? null,
      artist.popularity ?? null,
      source,
      addedByUserId,
      now
    )
    .run();

  if (result.meta.changes > 0) return { id, inserted: true };

  const existing = await db.prepare('SELECT id FROM artists WHERE spotify_id = ?').bind(artist.id).first<{ id: string }>();
  return { id: existing!.id, inserted: false };
}

export async function upsertTrack(
  db: D1Database,
  track: SpotifyTrackLike,
  artistInternalId: string,
  source: string,
  addedByUserId: string | null,
  now: number
): Promise<UpsertResult> {
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, album_image_url, preview_url, source, added_by_user_id, approved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(spotify_id) DO NOTHING`
    )
    .bind(id, track.id, track.name, artistInternalId, track.album?.images?.[0]?.url ?? null, track.preview_url ?? null, source, addedByUserId, now)
    .run();

  if (result.meta.changes > 0) return { id, inserted: true };

  const existing = await db.prepare('SELECT id FROM tracks WHERE spotify_id = ?').bind(track.id).first<{ id: string }>();
  return { id: existing!.id, inserted: false };
}
