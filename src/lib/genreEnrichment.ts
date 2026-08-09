import { lookupMusicBrainzArtistId, fetchMusicBrainzGenres } from './musicbrainz';
import { genresToObject, genresFromRow } from './genres';

// MusicBrainz's documented rate limit is 1 request/second per IP, strictly
// enforced (a 503 on violation) -- padded slightly above that to stay
// comfortably under it rather than shave the margin as thin as possible.
// This only protects a single run's own two sequential calls per artist;
// it assumes enrichment runs are triggered one at a time (matching
// src/db/seed.ts's same implicit assumption), not that multiple runs could
// overlap concurrently.
const MUSICBRAINZ_REQUEST_DELAY_MS = 1100;

// Each artist costs two sequential MusicBrainz calls plus the mandatory
// delay after each (~2.2s+ minimum). Bounded conservatively so one run
// comfortably finishes without needing to guess at this Worker's exact
// execution limits -- like SAFE_ARTISTS_PER_RUN in seed.ts, a run that hits
// this cap just leaves the rest for the next run: this always selects
// artists where genre_enriched_at IS NULL, so repeated calls make real
// incremental progress.
export const MUSICBRAINZ_ARTISTS_PER_RUN = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GenreEnrichmentResult {
  attempted: number;
  matched: number;
  noMbidMatch: number;
  matchedButNoGenres: number;
  failed: number;
}

// Deliberately not hooked into artist ingestion (upsertArtist) yet -- that
// runs inline on user-facing requests, and firing MusicBrainz calls from
// concurrent requests with no shared coordination is exactly the kind of
// thing that could spike past MusicBrainz's rate limit without anyone
// noticing until they respond. For now, new artists simply accumulate with
// genre_enriched_at IS NULL and get picked up whenever this batch runs next.
export async function enrichArtistGenresFromMusicBrainz(
  db: D1Database,
  limit: number = MUSICBRAINZ_ARTISTS_PER_RUN
): Promise<GenreEnrichmentResult> {
  const { results } = await db
    .prepare(`SELECT id, spotify_id, genres FROM artists WHERE genre_enriched_at IS NULL LIMIT ?`)
    .bind(limit)
    .all<{ id: string; spotify_id: string; genres: string }>();

  const result: GenreEnrichmentResult = { attempted: results.length, matched: 0, noMbidMatch: 0, matchedButNoGenres: 0, failed: 0 };

  for (const artist of results) {
    const now = Date.now();
    try {
      const mbid = await lookupMusicBrainzArtistId(artist.spotify_id);
      await sleep(MUSICBRAINZ_REQUEST_DELAY_MS);

      if (!mbid) {
        await db.prepare(`UPDATE artists SET genre_enriched_at = ? WHERE id = ?`).bind(now, artist.id).run();
        result.noMbidMatch++;
        continue;
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
              `INSERT INTO artist_musicbrainz_genres (artist_id, mb_genre_id, name, count, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (artist_id, mb_genre_id) DO UPDATE SET count = excluded.count`
            )
            .bind(artist.id, g.id, g.name, g.count, now)
        ),
      ];
      await db.batch(statements);

      result.matched++;
      if (mbGenres.length === 0) result.matchedButNoGenres++;
    } catch {
      // Leave genre_enriched_at unset on failure (network error, unexpected
      // MusicBrainz response) so this artist gets retried on the next run
      // instead of being silently treated the same as a genuine no-match.
      result.failed++;
    }
  }

  return result;
}
