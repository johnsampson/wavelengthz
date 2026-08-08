import { searchArtistsByGenre, fetchArtistTracks, getClientCredentialsToken } from './spotify';
import { recordCatalogGenres } from './genreCatalog';
import { upsertArtist, upsertTrack } from './catalogUpsert';
import { sendEmail } from './email';

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

    const tracks = await fetchArtistTracks(token, artist.id, TRACKS_PER_ARTIST);
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

  // Rotate the starting point so successive calls (15 minutes apart, per
  // the cron cadence) reach different genres over time instead of always
  // restarting from GROWTH_GENRES[0] and stalling on the first few -- the
  // whole point of widening this list past the original 12 is defeated if
  // genres 6+ are never reached until 1-5 are each individually exhausted.
  const ROTATION_INTERVAL_MS = 15 * 60 * 1000;
  const startIndex = Math.floor(now / ROTATION_INTERVAL_MS) % GROWTH_GENRES.length;
  const orderedGenres = [...GROWTH_GENRES.slice(startIndex), ...GROWTH_GENRES.slice(0, startIndex)];

  const token = await getClientCredentialsToken(env);
  let inserted = 0;
  const genresTried: string[] = [];
  const errors: Record<string, string> = {};

  for (const genre of orderedGenres) {
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

/**
 * The scheduled entry point (wired in src/index.ts's scheduled()). Writes
 * one row to catalog_growth_runs per invocation regardless of outcome --
 * that table is the source of truth the daily digest reads from. On a
 * whole-job failure (as opposed to a per-genre error, which growArtistCatalog
 * already isolates), sends an immediate email in addition to rethrowing so
 * the outer scheduled() handler's existing Sentry reporting still fires.
 */
export async function runCatalogGrowthJob(env: Env, now: number): Promise<void> {
  // Cast to string: wrangler.toml declares this var as the literal "true" in
  // both [vars] and [env.test.vars], so `wrangler types` infers the Env
  // field as the literal type "true" rather than `string` -- without this,
  // tsc flags the comparison below as unintentional (the two literal types
  // "true" and "false" can never overlap), even though the real deployed
  // value can be set to "false" out-of-band via `wrangler secret put` or the
  // dashboard (see the comment on ARTIST_CATALOG_GROWTH_ENABLED there).
  if ((env.ARTIST_CATALOG_GROWTH_ENABLED as string) === 'false') return;

  const id = crypto.randomUUID();
  try {
    const result = await growArtistCatalog(env, now, { maxInserted: 50 });
    const errorSummary = Object.keys(result.errors).length > 0 ? JSON.stringify(result.errors) : null;
    await env.DB.prepare(
      `INSERT INTO catalog_growth_runs (id, started_at, finished_at, genres_tried, inserted_count, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, now, Date.now(), JSON.stringify(result.genresTried), result.inserted, errorSummary, now).run();
    console.log('catalog growth run', { inserted: result.inserted, genresTried: result.genresTried, errors: result.errors });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('runCatalogGrowthJob failed', error);
    await env.DB.prepare(
      `INSERT INTO catalog_growth_runs (id, started_at, finished_at, genres_tried, inserted_count, error, created_at)
       VALUES (?, ?, ?, '[]', 0, ?, ?)`
    ).bind(id, now, Date.now(), message, now).run();

    if (env.OPS_ALERT_EMAIL) {
      await sendEmail(env, {
        to: env.OPS_ALERT_EMAIL,
        subject: 'Wavelengthz: artist catalog growth job failed',
        html: `<p>The scheduled artist catalog growth job failed:</p><pre>${message}</pre>`,
      }).catch(() => {});
    }
    throw error;
  }
}

/**
 * Reads catalog_growth_runs for the last 24h and emails one summary to
 * OPS_ALERT_EMAIL -- deliberately not a per-run email (the growth job runs
 * every 15 minutes; that would be 90+ emails/day). A no-op when
 * OPS_ALERT_EMAIL isn't configured, same as the failure path above.
 */
export async function sendCatalogGrowthDigest(env: Env, now: number): Promise<void> {
  if (!env.OPS_ALERT_EMAIL) return;

  const since = now - 24 * 60 * 60 * 1000;
  const rows = await env.DB.prepare(`SELECT inserted_count, error FROM catalog_growth_runs WHERE created_at >= ?`)
    .bind(since)
    .all<{ inserted_count: number; error: string | null }>();

  const totalInserted = rows.results.reduce((sum, r) => sum + r.inserted_count, 0);
  const runCount = rows.results.length;
  const failedCount = rows.results.filter((r) => r.error !== null).length;

  await sendEmail(env, {
    to: env.OPS_ALERT_EMAIL,
    subject: `Wavelengthz: artist catalog growth digest (${totalInserted} new artists today)`,
    html: `<p>${runCount} run(s) in the last 24h, ${totalInserted} new artist(s) inserted, ${failedCount} failed run(s).</p>`,
  });
}
