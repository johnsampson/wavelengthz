import { lookupMusicBrainzArtistId, fetchMusicBrainzGenres } from './musicbrainz';
import { genresToObject, genresFromRow } from './genres';

// MusicBrainz's documented rate limit is 1 request/second per IP, strictly
// enforced (a 503 on violation). Padded further than the usual 10% margin
// this codebase uses elsewhere (e.g. the 1.1x page-size caps in spotify.ts)
// because this now runs continuously for up to an hour via cron, not a
// short manual batch -- a small amount of per-iteration D1/CPU overhead
// compounding over thousands of iterations should never let the *effective*
// rate creep toward the real limit.
const MUSICBRAINZ_REQUEST_DELAY_MS = 1250;

// Fallback batch size for the plain manual/admin-triggered path (no
// deadline given) -- unchanged from before the cron existed, so
// POST /internal/enrich-genres without ?count= keeps its original,
// quick-to-run-by-hand behavior.
export const MUSICBRAINZ_ARTISTS_PER_RUN = 20;

// Upper bound on how many candidate rows get pulled into memory for a
// deadline-governed run. Real stopping condition is the deadline itself;
// this just exists so that query can't ever be literally unbounded. At
// ~2.5s/artist (two calls, each padded to MUSICBRAINZ_REQUEST_DELAY_MS),
// even a full hour tops out well under 2000 artists, so this is never
// expected to be the thing that actually stops a run.
const MUSICBRAINZ_DEADLINE_RUN_CANDIDATE_LIMIT = 5000;

// Self-imposed ceiling below the hourly cron interval, not the full hour --
// leaves a margin for the last in-flight artist's two calls plus D1 writes
// to finish well before the *next* hourly tick, rather than cutting it
// exactly at 60 minutes.
export const MUSICBRAINZ_CRON_MAX_RUNTIME_MS = 55 * 60 * 1000;

// Soft overlap guard for the cron path: without this, a run that
// legitimately overran its deadline (slow network, D1 hiccups) could still
// be finishing up right as the next hourly tick starts a second one,
// doubling MusicBrainz's effective request rate for that overlap window.
// KV has no atomic compare-and-swap, so this is a best-effort check, not a
// hard guarantee -- an acceptable gap given how unlikely a genuine overlap
// already is with the 5-minute buffer above, not worth reaching for a
// Durable Object just to close it. The queue consumer below doesn't need
// this guard itself -- max_concurrency = 1 on that queue's consumer config
// (wrangler.toml) is Cloudflare's own enforcement of the same one-at-a-time
// property, for the same underlying reason.
const MUSICBRAINZ_LOCK_KV_KEY = 'musicbrainz-enrichment-lock';
const MUSICBRAINZ_LOCK_TTL_SECONDS = 3600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type EnrichOneOutcome = 'matched' | 'matched_no_genres' | 'no_mbid_match' | 'failed';

// The actual two-call MusicBrainz lookup, shared by both the batch/cron path
// below and the queue consumer (queueGenreEnrichment.ts) -- one place doing
// the lookup, the merge-into-artists.genres, and the artist_genres write, so
// the two trigger paths can't drift out of sync with each other.
async function enrichOneArtist(db: D1Database, artist: { id: string; spotify_id: string; genres: string }): Promise<EnrichOneOutcome> {
  const now = Date.now();
  try {
    const mbid = await lookupMusicBrainzArtistId(artist.spotify_id);
    await sleep(MUSICBRAINZ_REQUEST_DELAY_MS);

    if (!mbid) {
      await db.prepare(`UPDATE artists SET genre_enriched_at = ? WHERE id = ?`).bind(now, artist.id).run();
      return 'no_mbid_match';
    }

    const mbGenres = await fetchMusicBrainzGenres(mbid);
    await sleep(MUSICBRAINZ_REQUEST_DELAY_MS);

    const mergedGenres = genresToObject([...genresFromRow(artist.genres), ...mbGenres.map((g) => g.name)]);
    const statements = [
      db
        .prepare(`UPDATE artists SET mbid = ?, genre_enriched_at = ?, genres = ? WHERE id = ?`)
        .bind(mbid, now, JSON.stringify(mergedGenres), artist.id),
      ...mbGenres.map((g) =>
        db
          .prepare(
            `INSERT INTO artist_genres (id, artist_id, mb_genre_id, name, count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (artist_id, mb_genre_id) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`
          )
          .bind(crypto.randomUUID(), artist.id, g.id, g.name, g.count, now, now)
      ),
    ];
    await db.batch(statements);

    return mbGenres.length === 0 ? 'matched_no_genres' : 'matched';
  } catch {
    // Leave genre_enriched_at unset on failure (network error, unexpected
    // MusicBrainz response) so this artist gets retried later instead of
    // being silently treated the same as a genuine no-match.
    return 'failed';
  }
}

function tally(result: GenreEnrichmentResult, outcome: EnrichOneOutcome) {
  if (outcome === 'matched') result.matched++;
  else if (outcome === 'matched_no_genres') {
    result.matched++;
    result.matchedButNoGenres++;
  } else if (outcome === 'no_mbid_match') result.noMbidMatch++;
  else result.failed++;
}

export interface GenreEnrichmentResult {
  attempted: number;
  matched: number;
  noMbidMatch: number;
  matchedButNoGenres: number;
  failed: number;
}

export interface GenreEnrichmentOptions {
  limit?: number;
  // Absolute timestamp (ms since epoch, Date.now()-comparable). Once
  // reached, no *new* artist is started -- an artist already in flight
  // always finishes its two calls rather than being cut off mid-way.
  deadline?: number;
}

// The catch-all sweep: picks up anything the queue path (below) didn't
// cover -- a message that exhausted its retries, or an artist that predates
// the queue existing -- in created_at order (oldest, i.e. longest-waiting,
// first). Runs hourly via cron (src/index.ts's scheduled handler) and is
// also reachable manually (POST /internal/enrich-genres) for a smaller,
// quick-to-run-by-hand batch.
export async function enrichArtistGenresFromMusicBrainz(
  db: D1Database,
  options: GenreEnrichmentOptions = {}
): Promise<GenreEnrichmentResult> {
  const limit = options.limit ?? (options.deadline ? MUSICBRAINZ_DEADLINE_RUN_CANDIDATE_LIMIT : MUSICBRAINZ_ARTISTS_PER_RUN);

  const { results } = await db
    .prepare(`SELECT id, spotify_id, genres FROM artists WHERE genre_enriched_at IS NULL ORDER BY created_at ASC LIMIT ?`)
    .bind(limit)
    .all<{ id: string; spotify_id: string; genres: string }>();

  const result: GenreEnrichmentResult = { attempted: 0, matched: 0, noMbidMatch: 0, matchedButNoGenres: 0, failed: 0 };

  for (const artist of results) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) break;
    result.attempted++;
    tally(result, await enrichOneArtist(db, artist));
  }

  return result;
}

export type HourlyGenreEnrichmentResult = GenreEnrichmentResult | { skipped: true; reason: 'already_running' };

// Cron entry point (see src/index.ts's scheduled handler, event.cron ===
// '0 * * * *'). Wraps the deadline-governed run above with the soft
// overlap guard described near MUSICBRAINZ_LOCK_KV_KEY.
export async function runHourlyGenreEnrichment(db: D1Database, kv: KVNamespace): Promise<HourlyGenreEnrichmentResult> {
  let lockAcquired = true;
  try {
    const existingLock = await kv.get(MUSICBRAINZ_LOCK_KV_KEY);
    if (existingLock !== null) return { skipped: true, reason: 'already_running' };
    await kv.put(MUSICBRAINZ_LOCK_KV_KEY, '1', { expirationTtl: MUSICBRAINZ_LOCK_TTL_SECONDS });
  } catch {
    // Fail open, matching this codebase's existing rate-limit-KV posture
    // (src/index.ts's rateLimitAllows) -- a KV outage shouldn't block genre
    // enrichment from running at all, it should just skip the overlap check.
    lockAcquired = false;
  }

  try {
    return await enrichArtistGenresFromMusicBrainz(db, { deadline: Date.now() + MUSICBRAINZ_CRON_MAX_RUNTIME_MS });
  } finally {
    if (lockAcquired) {
      try {
        await kv.delete(MUSICBRAINZ_LOCK_KV_KEY);
      } catch {
        // Self-expires via expirationTtl regardless -- next run is blocked
        // for at most an hour by a delete that failed here, never forever.
      }
    }
  }
}

export interface GenreEnrichmentQueueMessage {
  artistId: string;
}

// Queue consumer (see src/index.ts's `queue` export, and the
// musicbrainz-genre-enrichment queue in wrangler.toml). Enqueued right after
// a brand-new artist is inserted (see upsertArtist's callers), so most
// artists get enriched within seconds/minutes rather than waiting for the
// hourly sweep above. Messages are processed one at a time within a batch
// (never Promise.all'd) -- MusicBrainz's rate limit is global, not
// per-consumer-instance, so max_concurrency = 1 on the queue's consumer
// config keeps at most one batch in flight at a time, and this loop keeps
// the *messages within* that one batch sequential too.
export async function processGenreEnrichmentQueueBatch(batch: MessageBatch<GenreEnrichmentQueueMessage>, db: D1Database): Promise<void> {
  for (const message of batch.messages) {
    // Re-checks genre_enriched_at IS NULL here too: the hourly sweep may
    // have already claimed this artist by the time this message is
    // processed (queues don't guarantee immediate delivery), and re-doing
    // the work would just waste a MusicBrainz call for no new information.
    const artist = await db
      .prepare(`SELECT id, spotify_id, genres FROM artists WHERE id = ? AND genre_enriched_at IS NULL`)
      .bind(message.body.artistId)
      .first<{ id: string; spotify_id: string; genres: string }>();

    if (!artist) {
      message.ack();
      continue;
    }

    const outcome = await enrichOneArtist(db, artist);
    // No dead-letter queue configured -- a message that exhausts its
    // retries (wrangler.toml: max_retries = 3) is simply dropped. That's
    // fine here specifically because the hourly sweep above is a real
    // backstop that will pick the same artist up later; a dropped message
    // is a delay, not a permanently missed artist.
    if (outcome === 'failed') message.retry();
    else message.ack();
  }
}
