import { getValidAccessToken } from './tokens';
import { fetchArtistTracks, getClientCredentialsToken, searchArtistsByGenre } from './spotify';
import { recordCatalogGenres } from './genreCatalog';
import { upsertArtist, upsertTrack } from './catalogUpsert';
import { SEED_GENRES } from '../db/seed';
import type { UserRow } from './session';

export const TOP_UP_COUNT = 10;
const TRACKS_PER_ARTIST = 2;

async function topGenresForUser(db: D1Database, userId: string, limit: number): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT genre FROM user_genres WHERE user_id = ? ORDER BY (artist_count + track_count) DESC LIMIT ?`)
    .bind(userId, limit)
    .all<{ genre: string }>();
  const genres = rows.results.map((r) => r.genre);
  // A brand-new account (or, as observed against a real, heavily-seeded local
  // catalog, any account whose top few genres are already thoroughly
  // covered) needs a wider net than just 2-3 genres -- fall back to the same
  // broad genre list the admin catalog-seed script uses, so there's a real
  // chance of finding something not already in the catalog.
  return genres.length > 0 ? genres : SEED_GENRES;
}

/**
 * Called when GET /api/candidates/music finds zero unswiped artists for a
 * user -- rather than leaving them stuck on "No more candidates right now"
 * forever, pull fresh artists from Spotify (seeded from the user's own top
 * genres, falling back to a generic set for a brand-new account) directly
 * into the catalog. Returns how many were actually inserted so the caller
 * knows whether it's worth re-querying for candidates.
 */
export async function topUpArtistsForUser(env: Env, user: UserRow): Promise<number> {
  const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
  const genres = await topGenresForUser(env.DB, user.id, 3);
  const now = Date.now();
  let inserted = 0;

  for (const genre of genres) {
    if (inserted >= TOP_UP_COUNT) break;

    // A random offset rather than always 0: verified live against a
    // real, already-heavily-seeded local catalog that offset 0 (the most
    // popular artists per genre) is exactly what the admin catalog-seed
    // script already inserted first, so every "top 10" was already known and
    // nothing new was ever found. Varying the offset gives repeated top-ups
    // an actual chance at surfacing artists that aren't in the catalog yet.
    const offset = Math.floor(Math.random() * 50);
    let artists: Array<{ id: string; name: string; genres: string[]; images: Array<{ url: string }>; popularity: number }>;
    try {
      artists = await searchArtistsByGenre(token, genre, 10, offset);
    } catch (error) {
      console.error(`topUpArtistsForUser: search failed for genre "${genre}":`, error);
      continue;
    }

    for (const artist of artists) {
      if (inserted >= TOP_UP_COUNT) break;
      // Candidates require a real photo (src/routes/musicSwipes.ts) --
      // skipping here avoids inserting an artist that could never actually
      // surface as a candidate anyway.
      if (!artist.images?.[0]?.url) continue;

      const existing = await env.DB.prepare('SELECT 1 FROM artists WHERE spotify_id = ?').bind(artist.id).first();
      if (existing) continue;

      const artistResult = await upsertArtist(env.DB, artist, 'spotify_search', null, now);
      if (!artistResult.inserted) continue;
      inserted += 1;
      await recordCatalogGenres(env.DB, artist.genres ?? [], 'artist', now);
      await env.GENRE_ENRICHMENT_QUEUE.send({ artistId: artistResult.id });

      const tracks = await fetchArtistTracks(token, artist.id, TRACKS_PER_ARTIST);
      for (const track of tracks) {
        const trackResult = await upsertTrack(env.DB, track, artistResult.id, 'spotify_search', null, now);
        if (trackResult.inserted) await recordCatalogGenres(env.DB, artist.genres ?? [], 'track', now);
      }
    }
  }

  return inserted;
}
