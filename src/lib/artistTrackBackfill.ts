import { fetchArtistTracks, getClientCredentialsToken, SpotifyCooldownActiveError } from './spotify';
import { genresFromRow } from './genres';
import { recordCatalogGenres } from './genreCatalog';
import { upsertTrack } from './catalogUpsert';
import { writeArtistTracksCache } from './artistTracksCache';

export interface ArtistTrackBackfillMessage {
  artistId: string; // internal UUID -- tracks.artist_id needs this, not the Spotify id
  spotifyArtistId: string;
  limit: number;
}

// Best-effort dedup so N near-simultaneous first-viewers of the same
// brand-new artist enqueue one backfill job, not N of them each independently
// re-running the ~40-call fan-out this whole feature exists to move off the
// request path. KV has no compare-and-swap, so this is "best effort, not a
// hard guarantee," same posture as genreEnrichment.ts's MUSICBRAINZ_LOCK_KV_KEY
// -- worst case under a genuine race is a small handful of duplicate jobs,
// not an unbounded pile-on.
const BACKFILL_PENDING_TTL_SECONDS = 600;

function backfillPendingKey(spotifyArtistId: string): string {
  return `artist-backfill-pending:${spotifyArtistId}`;
}

// Called from GET /api/artists/:id (src/routes/catalog.ts) right after it
// serves a quick-path response. Deliberately checks-then-sends-then-locks,
// not lock-then-send: setting the pending flag before a successful send
// would leave this artist's backfill silently stuck for the full TTL if the
// send itself failed, with no job actually queued to show for it.
export async function enqueueArtistTrackBackfill(env: Env, message: ArtistTrackBackfillMessage): Promise<void> {
  try {
    const pending = await env.RATE_LIMIT_KV.get(backfillPendingKey(message.spotifyArtistId));
    if (pending !== null) return;
  } catch {
    // KV outage -- fail open (attempt the enqueue anyway) rather than
    // silently never backfilling this artist until the outage clears.
  }

  try {
    await env.ARTIST_TRACK_BACKFILL_QUEUE.send(message);
  } catch (err) {
    console.error('Failed to enqueue artist track backfill', err);
    return; // no lock set -- the next viewer's cache miss gets a fresh attempt
  }

  try {
    await env.RATE_LIMIT_KV.put(backfillPendingKey(message.spotifyArtistId), '1', { expirationTtl: BACKFILL_PENDING_TTL_SECONDS });
  } catch {
    // Non-fatal -- worst case a duplicate job gets enqueued before this
    // write would have expired anyway.
  }
}

// Queue consumer (src/index.ts's `queue` export, artist-track-backfill queue
// in wrangler.toml). Completes what a first view's quick path
// (fetchArtistTracksQuick, src/lib/spotify.ts) deliberately left undone --
// runs the same full fan-out GET /api/artists/:id used to run synchronously
// on every first view, but off the request path entirely, so a slow or
// rate-limited round trip here costs time, not a blocked page load or a
// "Spotify's a little busy" error for whoever's waiting on it.
export async function processArtistTrackBackfillBatch(batch: MessageBatch<ArtistTrackBackfillMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const artistRow = await env.DB.prepare('SELECT id, genres FROM artists WHERE id = ?')
        .bind(message.body.artistId)
        .first<{ id: string; genres: string }>();
      if (!artistRow) {
        // Artist was removed (or the message is stale/malformed) -- nothing
        // to backfill.
        message.ack();
        continue;
      }

      const token = await getClientCredentialsToken(env);
      const tracks = await fetchArtistTracks(token, message.body.spotifyArtistId, message.body.limit, 'background', env.RATE_LIMIT_KV);

      const artistGenres = genresFromRow(artistRow.genres);
      const now = Date.now();
      for (const track of tracks) {
        const result = await upsertTrack(env.DB, track, artistRow.id, 'spotify_search', null, now);
        if (result.inserted) await recordCatalogGenres(env.DB, artistGenres, 'track', now);
      }

      await writeArtistTracksCache(env.RATE_LIMIT_KV, message.body.spotifyArtistId, message.body.limit, tracks);
      message.ack();
    } catch (err) {
      if (err instanceof SpotifyCooldownActiveError) {
        // A cooldown-skip means we never even attempted a Spotify call for
        // this artist -- retry once the cooldown itself has cleared instead
        // of hot-looping straight back into it (the default immediate
        // retry every other error still gets, below).
        message.retry({ delaySeconds: Math.max(1, Math.ceil(err.remainingMs / 1000)) });
      } else {
        console.error('Artist track backfill failed', err);
        // No dead-letter queue configured -- a message that exhausts its
        // retries (wrangler.toml: max_retries = 3) is simply dropped. Same
        // reasoning as genreEnrichment.ts's queue consumer: the next viewer's
        // cache-miss quick-path request will attempt a fresh enqueue once the
        // pending-lock TTL clears, so this artist isn't permanently stuck.
        message.retry();
      }
    }
  }
}
