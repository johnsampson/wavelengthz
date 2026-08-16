import { fetchArtistById, getClientCredentialsToken } from './spotify';
import { recordCatalogGenres } from './genreCatalog';
import { upsertArtist, upsertTrack, type SpotifyTrackLike } from './catalogUpsert';

/**
 * A Spotify track object as returned by /v1/search?type=track and
 * /v1/me/player/currently-playing -- both carry the full `artists` array and
 * `album.images`, so nothing here ever needs a follow-up GET /v1/tracks/{id}.
 */
export interface ShareableSpotifyTrack extends SpotifyTrackLike {
  artists?: Array<{ id: string; name: string }>;
}

/**
 * Resolves a Spotify track into the shared catalog and returns its internal
 * `tracks.id` -- the id every in-app reference uses (music_swipes.item_id,
 * and now messages.track_id), never the Spotify id (see migrations/0002).
 *
 * Needed because `tracks.artist_id` is NOT NULL REFERENCES artists(id): you
 * cannot store a shared track without its artist also being in the catalog.
 * So this is "get-or-create, artist first, then track."
 *
 * DB-first per CLAUDE.md: both the track and its artist are looked up by
 * `spotify_id` before anything reaches for a token, and a fully-cached track
 * costs exactly one D1 query and zero Spotify calls. The only live call this
 * can ever make is GET /v1/artists/{id} -- and only when sharing a track by
 * an artist the catalog has never seen. It never calls GET /v1/tracks/{id}
 * (the search/now-playing payload already carries everything upsertTrack
 * needs) and never calls the album-tracks fan-out.
 *
 * A pleasant side effect: sharing songs quietly grows the catalog with music
 * real users actually care about, which is exactly the taste-weighted
 * material the discovery cron can't produce on its own.
 */
export async function resolveSharedTrack(
  env: Env,
  track: ShareableSpotifyTrack,
  userId: string
): Promise<{ trackId: string } | { error: 'invalid_track' | 'artist_unavailable' }> {
  if (!track?.id || !track.name) return { error: 'invalid_track' };

  // DB-first: an already-shared song (by far the common case once a thread
  // gets going) resolves here and stops.
  const existingTrack = await env.DB.prepare('SELECT id FROM tracks WHERE spotify_id = ?')
    .bind(track.id)
    .first<{ id: string }>();
  if (existingTrack) return { trackId: existingTrack.id };

  const spotifyArtist = track.artists?.[0];
  if (!spotifyArtist?.id) return { error: 'invalid_track' };

  const now = Date.now();

  // Same DB-first check for the artist, so a new track by a known artist
  // still costs zero Spotify calls.
  let artistInternalId: string;
  const existingArtist = await env.DB.prepare('SELECT id FROM artists WHERE spotify_id = ?')
    .bind(spotifyArtist.id)
    .first<{ id: string }>();

  if (existingArtist) {
    artistInternalId = existingArtist.id;
  } else {
    // The only live call in this whole path, and only for a genuinely
    // unknown artist. Fetched in full (rather than upserting the stub the
    // track payload carries) so the artist lands with genres and an image --
    // without those it could never surface as a deck candidate, and its
    // genres would be missing from every affinity calculation.
    try {
      const token = await getClientCredentialsToken(env);
      const fullArtist = await fetchArtistById(token, spotifyArtist.id);
      const upserted = await upsertArtist(env.DB, fullArtist, 'user_added', userId, now);
      artistInternalId = upserted.id;
      if (upserted.inserted) {
        await recordCatalogGenres(env.DB, fullArtist.genres ?? [], 'artist', now);
        await env.GENRE_ENRICHMENT_QUEUE.send({ artistId: upserted.id });
      }
    } catch (error) {
      // Spotify unavailable/rate-limited. Surfaced as a distinct error so the
      // caller can say "couldn't share that right now" instead of silently
      // dropping the message -- the send is rejected rather than stored
      // without its track.
      console.error('resolveSharedTrack: artist resolution failed', error);
      return { error: 'artist_unavailable' };
    }
  }

  const upsertedTrack = await upsertTrack(env.DB, track, artistInternalId, 'user_added', userId, now);
  if (upsertedTrack.inserted) {
    const artistRow = await env.DB.prepare('SELECT genres FROM artists WHERE id = ?')
      .bind(artistInternalId)
      .first<{ genres: string }>();
    if (artistRow) {
      const genres: string[] = Object.keys(JSON.parse(artistRow.genres));
      await recordCatalogGenres(env.DB, genres, 'track', now);
    }
  }

  return { trackId: upsertedTrack.id };
}

/**
 * The shape a track takes in a message payload / playlist response. Kept in
 * one place because the match thread, the group thread, and both derived
 * playlists all render it identically.
 *
 * spotifyId rides along because the player bar plays via Spotify's embed/SDK
 * and needs the real id, while `id` is what messages.track_id stores -- the
 * same split GET /api/artists/:id already exposes for its track rows.
 */
export interface SharedTrackView {
  id: string;
  spotifyId: string;
  name: string;
  artistName: string | null;
  imageUrl: string | null;
}

/**
 * Batch-loads the renderable track data for a set of internal track ids. One
 * query for a whole thread rather than one per message -- the same
 * batched-not-per-row discipline peopleSwipes.ts's primaryPhotoUrls uses, and
 * a hard requirement here since a long thread would otherwise blow through
 * the Workers subrequest limit.
 */
export async function loadSharedTracks(db: D1Database, trackIds: string[]): Promise<Map<string, SharedTrackView>> {
  const byId = new Map<string, SharedTrackView>();
  const unique = [...new Set(trackIds.filter(Boolean))];
  if (unique.length === 0) return byId;

  const placeholders = unique.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT t.id, t.spotify_id, t.name, t.album_image_url, a.name AS artist_name
       FROM tracks t
       LEFT JOIN artists a ON a.id = t.artist_id
       WHERE t.id IN (${placeholders})`
    )
    .bind(...unique)
    .all<{ id: string; spotify_id: string; name: string; album_image_url: string | null; artist_name: string | null }>();

  for (const row of rows.results) {
    byId.set(row.id, {
      id: row.id,
      spotifyId: row.spotify_id,
      name: row.name,
      artistName: row.artist_name,
      imageUrl: row.album_image_url,
    });
  }
  return byId;
}
