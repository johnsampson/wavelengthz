import { searchArtistsByGenre, searchTracksByArtistName, getClientCredentialsToken } from './spotify';
import { recordCatalogGenres } from './genreCatalog';
import { upsertArtist, upsertTrack } from './catalogUpsert';

// Wider than src/db/seed.ts's SEED_GENRES (used only for the one-time
// initial catalog build). Growth runs forever and must never let a user
// see a repeat, so more genres means more total addressable artists before
// the shared catalog's ceiling is reached.
export const GROWTH_GENRES = [
  'pop', 'hip-hop', 'indie', 'r-n-b', 'country', 'electronic',
  'latin', 'rock', 'k-pop', 'jazz', 'classical', 'reggaeton',
  'metal', 'folk', 'soul', 'funk', 'blues', 'punk', 'alternative', 'dance',
];

// Same real Spotify limits src/db/seed.ts's seedCatalog already relies on:
// /v1/search's documented per-page max is 10, and offset+limit can't exceed
// Spotify's own 1000 cap.
const SEARCH_PAGE_SIZE = 10;
const SPOTIFY_MAX_OFFSET = 950;
const TRACKS_PER_ARTIST = 2;

interface GenreCursor {
  genre: string;
  searchOffset: number;
  exhausted: boolean;
}

async function loadCursor(db: D1Database, genre: string): Promise<GenreCursor> {
  const row = await db
    .prepare('SELECT search_offset, exhausted FROM genre_search_cursors WHERE genre = ?')
    .bind(genre)
    .first<{ search_offset: number; exhausted: number }>();
  if (!row) return { genre, searchOffset: 0, exhausted: false };
  return { genre, searchOffset: row.search_offset, exhausted: row.exhausted === 1 };
}

async function saveCursor(db: D1Database, cursor: GenreCursor, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO genre_search_cursors (genre, search_offset, exhausted, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(genre) DO UPDATE SET search_offset = excluded.search_offset, exhausted = excluded.exhausted, updated_at = excluded.updated_at`
    )
    .bind(cursor.genre, cursor.searchOffset, cursor.exhausted ? 1 : 0, now)
    .run();
}

/**
 * Searches ONE page of one genre at its persisted offset, inserts any
 * genuinely new artist (+ up to TRACKS_PER_ARTIST tracks each), and
 * advances the genre's cursor. A genre is marked exhausted once a page
 * comes back short of SEARCH_PAGE_SIZE or the offset has walked past
 * Spotify's real max -- never on a search error, so a transient failure
 * retries the same offset next time instead of skipping ahead.
 */
export async function growOneGenre(db: D1Database, token: string, genre: string, now: number): Promise<{ inserted: number }> {
  const cursor = await loadCursor(db, genre);
  if (cursor.searchOffset > SPOTIFY_MAX_OFFSET) {
    if (!cursor.exhausted) await saveCursor(db, { ...cursor, exhausted: true }, now);
    return { inserted: 0 };
  }

  const artists = await searchArtistsByGenre(token, genre, SEARCH_PAGE_SIZE, cursor.searchOffset);

  let inserted = 0;
  for (const artist of artists) {
    // Candidates require a real photo (src/routes/musicSwipes.ts) -- skip
    // here so nothing gets inserted that could never actually surface.
    if (!artist.images?.[0]?.url) continue;

    const existing = await db.prepare('SELECT 1 FROM artists WHERE spotify_id = ?').bind(artist.id).first();
    if (existing) continue;

    const artistResult = await upsertArtist(db, artist, 'spotify_search', null, now);
    if (!artistResult.inserted) continue;
    inserted += 1;
    await recordCatalogGenres(db, artist.genres ?? [], 'artist', now);

    const tracks = await searchTracksByArtistName(token, artist.name, TRACKS_PER_ARTIST);
    for (const track of tracks) {
      const trackResult = await upsertTrack(db, track, artistResult.id, 'spotify_search', null, now);
      if (trackResult.inserted) await recordCatalogGenres(db, artist.genres ?? [], 'track', now);
    }
  }

  await saveCursor(
    db,
    { genre, searchOffset: cursor.searchOffset + SEARCH_PAGE_SIZE, exhausted: artists.length < SEARCH_PAGE_SIZE },
    now
  );

  return { inserted };
}

export interface GrowthResult {
  inserted: number;
  genresTried: string[];
  errors: Record<string, string>;
}

/**
 * Round-robins GROWTH_GENRES (in list order) via growOneGenre, stopping
 * once maxInserted new artists have been inserted, maxGenres real Spotify
 * attempts have been made (if given -- the reactive fallback in
 * musicSwipes.ts bounds this to keep a live request's latency reasonable;
 * the cron job leaves it unbounded), or every genre has been considered
 * once. A genre already known exhausted is skipped without costing a
 * Spotify call or counting against maxGenres. If every genre was already
 * exhausted before this call started, all cursors are reset to offset 0
 * first so growth never stalls permanently.
 */
export async function growArtistCatalog(
  env: Env,
  now: number,
  options: { maxInserted: number; maxGenres?: number }
): Promise<GrowthResult> {
  const cursorRows = await env.DB.prepare('SELECT genre, exhausted FROM genre_search_cursors').all<{ genre: string; exhausted: number }>();
  let exhaustedByGenre = new Map(cursorRows.results.map((r) => [r.genre, r.exhausted === 1]));
  const allExhausted = GROWTH_GENRES.every((genre) => exhaustedByGenre.get(genre) === true);

  if (allExhausted) {
    for (const genre of GROWTH_GENRES) {
      await env.DB.prepare(
        `INSERT INTO genre_search_cursors (genre, search_offset, exhausted, updated_at) VALUES (?, 0, 0, ?)
         ON CONFLICT(genre) DO UPDATE SET search_offset = 0, exhausted = 0, updated_at = excluded.updated_at`
      ).bind(genre, now).run();
    }
    exhaustedByGenre = new Map(GROWTH_GENRES.map((genre) => [genre, false]));
  }

  const token = await getClientCredentialsToken(env);
  let inserted = 0;
  const genresTried: string[] = [];
  const errors: Record<string, string> = {};

  for (const genre of GROWTH_GENRES) {
    if (inserted >= options.maxInserted) break;
    if (options.maxGenres !== undefined && genresTried.length >= options.maxGenres) break;
    if (exhaustedByGenre.get(genre)) continue;

    genresTried.push(genre);
    try {
      const { inserted: genreInserted } = await growOneGenre(env.DB, token, genre, now);
      inserted += genreInserted;
    } catch (error) {
      errors[genre] = error instanceof Error ? error.message : String(error);
    }
  }

  return { inserted, genresTried, errors };
}
