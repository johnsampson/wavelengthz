import { fetchGenreArtistCount } from './musicbrainz';

// Same padding as genreEnrichment.ts's MUSICBRAINZ_REQUEST_DELAY_MS, and for
// the same reason -- MusicBrainz's 1 request/second limit is global across
// everything this app does with their API, not per code path. This and the
// artist-genre enrichment pipeline must never run concurrently; see
// runHourlyGenreEnrichment in genreEnrichment.ts, which runs this as a
// second phase sharing the same lock and deadline rather than as an
// independently-scheduled job.
const MUSICBRAINZ_REQUEST_DELAY_MS = 1250;

// The genres table is small (a few dozen to a few hundred distinct genre
// strings, not thousands of artists) and grows slowly -- this is a generous
// safety net, not the real stopping condition. A deadline-governed call
// (the normal case, via the hourly cron) stops on time instead.
const GENRE_DENSITY_CANDIDATE_LIMIT = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GenreDensityResult {
  attempted: number;
  updated: number;
  failed: number;
}

export interface GenreDensityOptions {
  limit?: number;
  // Absolute timestamp (ms since epoch). No *new* genre is started once
  // reached -- one already in flight always finishes its single call.
  deadline?: number;
}

// Fetches each not-yet-checked genre's corpus-wide MusicBrainz density
// (musicbrainz_artist_count) -- distinct from artist_count/track_count on
// the same table, which count this app's own catalog, not all of
// MusicBrainz. musicbrainz_density_fetched_at is only set on success,
// matching genreEnrichment.ts's convention -- a transient failure gets
// retried on the next run rather than being treated as a permanently
// unknown density.
export async function fetchGenreDensities(db: D1Database, options: GenreDensityOptions = {}): Promise<GenreDensityResult> {
  const limit = options.limit ?? GENRE_DENSITY_CANDIDATE_LIMIT;

  const { results } = await db
    .prepare(`SELECT id, genre FROM genres WHERE musicbrainz_density_fetched_at IS NULL ORDER BY created_at ASC LIMIT ?`)
    .bind(limit)
    .all<{ id: string; genre: string }>();

  const result: GenreDensityResult = { attempted: 0, updated: 0, failed: 0 };

  for (const row of results) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) break;
    result.attempted++;

    try {
      const count = await fetchGenreArtistCount(row.genre);
      await sleep(MUSICBRAINZ_REQUEST_DELAY_MS);

      const now = Date.now();
      await db
        .prepare(`UPDATE genres SET musicbrainz_artist_count = ?, musicbrainz_density_fetched_at = ?, updated_at = ? WHERE id = ?`)
        .bind(count, now, now, row.id)
        .run();
      result.updated++;
    } catch {
      // Leave musicbrainz_density_fetched_at unset on failure, same
      // reasoning as genreEnrichment.ts's enrichOneArtist -- a transient
      // error shouldn't be indistinguishable from "checked, density is 0".
      result.failed++;
    }
  }

  return result;
}
