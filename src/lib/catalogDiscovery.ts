import { getClientCredentialsToken, searchArtistsByGenre, SpotifyCooldownActiveError } from './spotify';
import { recordCatalogGenres } from './genreCatalog';
import { upsertArtist } from './catalogUpsert';
import { enqueueArtistTrackBackfill } from './artistTrackBackfill';
import { SEED_GENRES } from '../db/seed';

/**
 * Scheduled, artist-only catalog growth.
 *
 * The only other job that grows the catalog on a schedule
 * (src/db/catalogRefresh.ts's refreshCatalogFromProfiles) is structurally
 * capped by the user count: it can only ever add artists that already appear
 * in some existing user's Spotify top-artists list, so on a small user base
 * it exhausts itself on the first run and adds ~nothing forever after. The
 * only broad discovery paths were `POST /internal/seed` (manual) and
 * topUpArtistsForUser (reactive -- fires only once a user's deck is already
 * empty). Nothing grew the catalog unattended.
 *
 * Deliberately artist-only. GET /v1/search?type=artist returns ten *complete*
 * artist objects (id/name/genres/images/popularity -- everything upsertArtist
 * needs) for a single API call, so artists cost ~0.1 calls each. Tracks are
 * the expensive half: fetchArtistTracks fans out to one albums-list call plus
 * one GET /v1/albums/{id}/tracks per album, per artist -- the exact endpoint
 * named in the production rate-limit reports quoted in spotifyThrottle.ts. So
 * this job never calls it, and never calls GET /v1/tracks/{id} either (that
 * remains reachable only from POST /api/tracks, one call per deliberate user
 * action).
 *
 * Tracks instead stay demand-driven: GET /api/artists/:id already quick-
 * fetches and enqueues a backfill the first time a human actually opens an
 * artist, so track-call budget is spent only on artists someone expressed
 * interest in rather than on every speculatively-discovered one. See
 * TRACK_BACKFILL_PER_RUN below for the one bounded exception.
 */

// Artists requested per Spotify search call. Spotify's documented max for
// /v1/search's `limit` is 10 (see the note on SEARCH_PAGE_SIZE in
// src/db/seed.ts -- larger values are rejected outright), so this is the
// ceiling, not a tuning knob.
const ARTISTS_PER_SEARCH = 10;

// Genres to advance per run, out of SEED_GENRES. Kept well below the full
// list so one run stays cheap (this many Spotify calls, plus a few D1 queries
// per artist) and so the cursor below spreads coverage evenly across the
// whole genre list over successive runs rather than racing one genre to
// exhaustion.
const GENRES_PER_RUN = 4;

// Spotify caps offset+limit at 1000 for search (SPOTIFY_MAX_OFFSET in
// src/db/seed.ts). Past this the API errors rather than returning an empty
// page, so the cursor wraps back to 0 instead -- by which point a full lap
// has been made and re-walking finds whatever has been added to Spotify
// since. Effective ceiling is ~1000 artists per genre, ~12k across the
// current SEED_GENRES list; widen SEED_GENRES to raise it.
const MAX_SEARCH_OFFSET = 950;

// Bounded track-backfill enqueue per run, highest Spotify `popularity`
// first. This job never fetches tracks itself -- it only hands ids to the
// existing artist-track-backfill queue, whose consumer does the fetching at
// its own pace with its own cooldown checks (src/lib/artistTrackBackfill.ts).
// Exists because the deck's "play a song" chip reads a representative
// cataloged track (src/routes/musicSwipes.ts), so a purely artist-only
// catalog would show freshly-discovered artists with no play button until
// someone happened to open their page. Set to 0 for strictly zero
// track-related work of any kind.
//
// Was 3 -- issue #145 (Round 7) item 5: "it does not appear to be pulling
// down cron tracks frequently. Maybe 10 to 20 overnight." At 3 per run x 4
// runs/day (wrangler.toml's "30 */6 * * *"), that's only 12 artists/day
// getting a backfill queued at all, consistent with the complaint. Raising
// this doesn't add burst risk: the backfill queue's own consumer
// (wrangler.toml: max_concurrency = 1, one artist processed at a time) is
// what actually paces the Spotify calls, so a bigger number here just grows
// the queue's backlog, not the call rate.
const TRACK_BACKFILL_PER_RUN = 10;

// Matches ARTIST_PROFILE_TRACK_LIMIT (src/routes/catalog.ts) -- the same
// depth a real first view of an artist page asks for, so a pre-warmed artist
// is already fully covered when someone does open it.
const BACKFILL_TRACK_LIMIT = 30;

const CURSOR_KV_PREFIX = 'catalog-discovery-cursor:';

function cursorKey(genre: string): string {
  return `${CURSOR_KV_PREFIX}${genre}`;
}

/**
 * Which genres this run should advance, and the search offset to use for
 * each. Pure apart from the KV reads, and exported for tests.
 *
 * A per-genre cursor rather than topUpArtistsForUser's random offset:
 * randomness increasingly collides with what's already stored as the catalog
 * fills (that function's own comment records offset 0 finding nothing but
 * already-known artists), whereas an advancing cursor makes every run walk
 * fresh ground. The starting genre rotates with the run counter so a single
 * genre isn't walked to exhaustion before the others are touched at all.
 */
export async function nextDiscoveryTargets(
  kv: KVNamespace,
  genres: string[],
  genresPerRun: number,
  runIndex: number
): Promise<Array<{ genre: string; offset: number }>> {
  const targets: Array<{ genre: string; offset: number }> = [];
  if (genres.length === 0) return targets;

  for (let i = 0; i < Math.min(genresPerRun, genres.length); i += 1) {
    const genre = genres[(runIndex * genresPerRun + i) % genres.length];
    let offset = 0;
    try {
      const stored = await kv.get(cursorKey(genre));
      const parsed = Number(stored);
      // A missing key, or anything non-numeric/negative/past the API's own
      // ceiling, restarts this genre from 0 rather than failing the run.
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_SEARCH_OFFSET) offset = parsed;
    } catch {
      // KV read failure -- fall back to offset 0. Worst case this run
      // re-walks ground already covered and inserts nothing new.
    }
    targets.push({ genre, offset });
  }

  return targets;
}

/**
 * Advances the stored cursor for a genre. Wraps to 0 once past Spotify's
 * offset ceiling. Never throws -- a KV write failure just means the next run
 * re-walks this page, which is wasteful but harmless.
 */
async function advanceCursor(kv: KVNamespace, genre: string, currentOffset: number): Promise<void> {
  const next = currentOffset + ARTISTS_PER_SEARCH;
  try {
    await kv.put(cursorKey(genre), String(next > MAX_SEARCH_OFFSET ? 0 : next));
  } catch {
    // Non-fatal, see above.
  }
}

export interface DiscoveryResult {
  artistsAdded: number;
  genresSearched: number;
  backfillsEnqueued: number;
  /** Set when the run stopped early because Spotify is in app-wide cooldown. */
  cooledDown: boolean;
}

/**
 * One discovery run. Safe to call unattended: every failure mode degrades to
 * "added fewer artists this time" rather than throwing.
 *
 * `runIndex` selects which slice of the genre list to advance -- the caller
 * (src/index.ts's scheduled handler) derives it from the wall clock so
 * successive runs rotate through the list without needing any stored state
 * beyond the per-genre offsets.
 */
export async function discoverArtistsByGenre(env: Env, runIndex: number): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { artistsAdded: 0, genresSearched: 0, backfillsEnqueued: 0, cooledDown: false };

  const targets = await nextDiscoveryTargets(env.RATE_LIMIT_KV, SEED_GENRES, GENRES_PER_RUN, runIndex);
  if (targets.length === 0) return result;

  let token: string;
  try {
    token = await getClientCredentialsToken(env);
  } catch (error) {
    console.error('discoverArtistsByGenre: token fetch failed', error);
    return result;
  }

  // Collected across the whole run so the bounded backfill enqueue below can
  // pick the genuinely most popular artists of the run, not just the most
  // popular within whichever genre happened to come first.
  const inserted: Array<{ id: string; spotifyId: string; popularity: number }> = [];

  for (const { genre, offset } of targets) {
    let artists: Array<{ id: string; name: string; genres?: string[]; images?: Array<{ url: string }>; popularity?: number }>;
    try {
      artists = await searchArtistsByGenre(token, genre, ARTISTS_PER_SEARCH, offset, env.RATE_LIMIT_KV);
    } catch (error) {
      // searchArtistsByGenre checks the app-wide cooldown flag itself and
      // throws SpotifyCooldownActiveError without ever hitting the network.
      // Stop the whole run rather than trying the remaining genres, which
      // would each throw the same way -- this is background-priority work
      // with no deadline, so the next scheduled run picks it up.
      if (error instanceof SpotifyCooldownActiveError) {
        result.cooledDown = true;
        break;
      }
      console.error(`discoverArtistsByGenre: search failed for genre "${genre}"`, error);
      continue;
    }

    result.genresSearched += 1;
    // Advanced even when the page yields nothing insertable -- the point is
    // to keep walking forward, and a page of already-known artists is
    // exactly the case a non-advancing cursor would get stuck on.
    await advanceCursor(env.RATE_LIMIT_KV, genre, offset);

    const now = Date.now();
    for (const artist of artists) {
      // Artist candidates require a real photo (src/routes/musicSwipes.ts's
      // photoFilter), so a photoless artist could never surface in the deck
      // anyway -- skipping here keeps the catalog free of rows that only
      // ever cost storage. Same reasoning as topUpArtistsForUser's own skip.
      if (!artist.images?.[0]?.url) continue;

      try {
        const existing = await env.DB.prepare('SELECT 1 FROM artists WHERE spotify_id = ?').bind(artist.id).first();
        if (existing) continue;

        const upserted = await upsertArtist(env.DB, artist, 'spotify_search', null, now);
        if (!upserted.inserted) continue;

        result.artistsAdded += 1;
        await recordCatalogGenres(env.DB, artist.genres ?? [], 'artist', now);
        await env.GENRE_ENRICHMENT_QUEUE.send({ artistId: upserted.id });
        inserted.push({ id: upserted.id, spotifyId: artist.id, popularity: artist.popularity ?? 0 });
      } catch (error) {
        // One bad artist row must not abort an unattended run.
        console.error(`discoverArtistsByGenre: failed to store artist "${artist.id}"`, error);
      }
    }
  }

  // Bounded, popularity-ranked pre-warm. Enqueue only -- the queue consumer
  // does every actual Spotify track call, at its own pace.
  if (TRACK_BACKFILL_PER_RUN > 0 && inserted.length > 0) {
    const mostPopular = [...inserted].sort((a, b) => b.popularity - a.popularity).slice(0, TRACK_BACKFILL_PER_RUN);
    for (const artist of mostPopular) {
      try {
        await enqueueArtistTrackBackfill(env, {
          artistId: artist.id,
          spotifyArtistId: artist.spotifyId,
          limit: BACKFILL_TRACK_LIMIT,
        });
        result.backfillsEnqueued += 1;
      } catch (error) {
        console.error(`discoverArtistsByGenre: backfill enqueue failed for "${artist.spotifyId}"`, error);
      }
    }
  }

  return result;
}
