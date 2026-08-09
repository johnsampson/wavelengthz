import { fetchArtistTracks, getClientCredentialsToken, searchArtistsByGenre } from '../lib/spotify';
import { recordCatalogGenres } from '../lib/genreCatalog';
import { upsertArtist, upsertTrack } from '../lib/catalogUpsert';

export const SEED_GENRES = [
  'pop', 'hip-hop', 'indie', 'r-n-b', 'country', 'electronic',
  'latin', 'rock', 'k-pop', 'jazz', 'classical', 'reggaeton',
];

const ARTISTS_PER_GENRE = 5; // used only to size the default target when none is requested
const TRACKS_PER_ARTIST = 2;
// Spotify's actual documented max for /v1/search's `limit` is 10 (default 5)
// -- NOT the more commonly-assumed 50 that applies to some of their other
// endpoints. Confirmed directly against Spotify's current API docs after
// `limit=50` came back as a uniform `400 Invalid limit` across every genre.
const SEARCH_PAGE_SIZE = 10;
const SPOTIFY_MAX_OFFSET = 950; // Spotify caps offset+limit at 1000 for search

// Cloudflare Workers cap outbound calls (fetch + D1 queries share the same
// budget) per request at 1000 (Paid) / 50 (Free). Fully processing one new
// artist costs up to 9 subrequests (existence check + artist insert, an
// artist-albums fetch, up to 2 album-tracks fetches, a batch track-details
// fetch, up to 2 track inserts, plus one GENRE_ENRICHMENT_QUEUE.send on
// insert -- fetchArtistTracks's albums-based lookup costs more round trips
// than the single search call it replaced, but is actually reliable; see
// spotify.ts), on top of periodic search-page calls and the initial
// client-credentials call. Whether a queue send draws against this exact
// same budget or a separate Queues-specific quota isn't confirmed -- folded
// into the same worst-case count here since assuming the less generous case
// costs nothing. This keeps a single run
// comfortably under that ceiling on a deployed Worker, so a large requested
// count degrades to "seed as many as safely fit in this run, report the
// rest" (see `reachedTarget`) rather than risking a mid-run platform
// failure. Already-known artists are skipped via a cheap existence check
// before any of that per-artist cost is paid, so re-running the same
// request makes real incremental progress toward a larger cumulative total
// across multiple calls.
export const SAFE_ARTISTS_PER_RUN = 100;

export async function seedCatalog(
  env: Env,
  options?: { targetTotal?: number }
): Promise<{
  artistsInserted: number;
  tracksInserted: number;
  failedArtistIds: string[];
  requestedTotal: number;
  reachedTarget: boolean;
  genreSearchErrors: Record<string, string>;
}> {
  const requestedTotal = options?.targetTotal ?? SEED_GENRES.length * ARTISTS_PER_GENRE;
  const target = Math.min(requestedTotal, SAFE_ARTISTS_PER_RUN);

  const token = await getClientCredentialsToken(env);
  const seen = new Set<string>();
  let artistsInserted = 0;
  let tracksInserted = 0;
  const failedArtistIds: string[] = [];
  // A genre's search request failing (vs. its results just running out) is
  // otherwise indistinguishable from "no more artists in this genre" -- both
  // mark the genre exhausted and move on. That's fine for a transient 429,
  // but a systemic failure (bad credentials, a since-changed Spotify query
  // syntax) would previously produce a silent all-zero result with no way to
  // tell those two cases apart. Recording the actual error per genre here
  // makes that failure mode visible in the response, not just guessable.
  const genreSearchErrors: Record<string, string> = {};
  const now = Date.now();

  const offsets = new Map<string, number>(SEED_GENRES.map((genre) => [genre, 0]));
  const exhausted = new Set<string>();

  // Round-robin across genres (rather than draining one genre before moving
  // to the next) so a small/default target still gets a spread across
  // genres, while a large target naturally paginates deeper into each genre
  // over successive rounds.
  while (artistsInserted < target && exhausted.size < SEED_GENRES.length) {
    for (const genre of SEED_GENRES) {
      if (exhausted.has(genre)) continue;
      if (artistsInserted >= target) break;

      const offset = offsets.get(genre)!;
      if (offset > SPOTIFY_MAX_OFFSET) {
        exhausted.add(genre);
        continue;
      }

      let artists: Array<{ id: string; name: string; genres: string[]; images: Array<{ url: string }>; popularity: number }>;
      try {
        artists = await searchArtistsByGenre(token, genre, SEARCH_PAGE_SIZE, offset);
      } catch (error) {
        // A page's search failing (transient 429/500, or something more
        // systemic) shouldn't abort the whole run -- treat this genre as
        // exhausted for this run and move on. But record why, so a run that
        // fails for every genre is diagnosable from the response instead of
        // looking identical to "there just weren't any more artists."
        const message = error instanceof Error ? error.message : String(error);
        genreSearchErrors[genre] = message;
        console.error(`seedCatalog: search failed for genre "${genre}" at offset ${offset}: ${message}`);
        exhausted.add(genre);
        continue;
      }

      if (artists.length === 0) {
        exhausted.add(genre);
        continue;
      }
      offsets.set(genre, offset + SEARCH_PAGE_SIZE);
      if (artists.length < SEARCH_PAGE_SIZE) exhausted.add(genre); // last page for this genre

      for (const artist of artists) {
        if (artistsInserted >= target) break;
        if (seen.has(artist.id)) continue;
        seen.add(artist.id);

        const existing = await env.DB.prepare('SELECT 1 FROM artists WHERE spotify_id = ?').bind(artist.id).first();
        if (existing) continue; // already in the catalog -- skip the expensive top-tracks fetch entirely

        try {
          // Wrap the full per-artist unit of work (artist insert + track
          // search + track inserts) so a failure anywhere in it -- most likely
          // a transient error from the track search, but also possible on
          // the insert itself -- only drops this one artist, not the run.
          const artistResult = await upsertArtist(env.DB, artist, 'seed', null, now);
          if (artistResult.inserted) {
            artistsInserted += 1;
            await recordCatalogGenres(env.DB, artist.genres ?? [], 'artist', now);
            await env.GENRE_ENRICHMENT_QUEUE.send({ artistId: artistResult.id });
          }

          const tracks = await fetchArtistTracks(token, artist.id, TRACKS_PER_ARTIST);
          for (const track of tracks) {
            const trackResult = await upsertTrack(env.DB, track, artistResult.id, 'seed', null, now);
            if (trackResult.inserted) {
              tracksInserted += 1;
              await recordCatalogGenres(env.DB, artist.genres ?? [], 'track', now);
            }
          }
        } catch {
          failedArtistIds.push(artist.id);
        }
      }
    }
  }

  return {
    artistsInserted,
    tracksInserted,
    failedArtistIds,
    requestedTotal,
    reachedTarget: artistsInserted >= requestedTotal,
    genreSearchErrors,
  };
}
