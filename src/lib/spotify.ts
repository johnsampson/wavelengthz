import { markSpotifyCooldown, isSpotifyCoolingDown } from './spotifyThrottle';

export interface SpotifyTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  // Space-separated, exactly as Spotify returns it -- persisted to
  // music_source_tokens.granted_scope (migration 0008) so src/routes/player.ts
  // can check for `streaming` without a live Spotify call. Always present on
  // a real Spotify response; optional here only because nothing enforces it
  // in tests that stub a bare {access_token, refresh_token, expires_in}.
  scope?: string;
}

// Thrown by spotifyFetch specifically when Spotify is still 429ing after a
// retry -- distinct from the generic Error every other failure mode throws,
// so src/index.ts's global handler can tell "Spotify is rate-limiting us"
// apart from "something is actually broken" and return an honest, distinct
// status instead of folding it into a blanket 500 with no indication rate
// limiting was ever involved.
export class SpotifyRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpotifyRateLimitError';
  }
}

// Thrown by fetchArtistTracks/searchArtistsByGenre (never by spotifyFetch
// itself) when a 'background'-priority call is skipped because
// isSpotifyCoolingDown (src/lib/spotifyThrottle.ts) reports an active
// cooldown -- meaning this call was never even attempted, unlike
// SpotifyRateLimitError which means Spotify was actually asked and said no
// after real retries. src/lib/artistTrackBackfill.ts's queue consumer
// checks for this specifically to retry with a delay matching the
// remaining cooldown instead of the default immediate retry every other
// error gets.
export class SpotifyCooldownActiveError extends Error {
  remainingMs: number;
  constructor(remainingMs: number) {
    super(`Skipping Spotify call -- app-wide cooldown active for another ${Math.ceil(remainingMs / 1000)}s`);
    this.name = 'SpotifyCooldownActiveError';
    this.remainingMs = remainingMs;
  }
}

// Spotify enforces its own app-wide rate limit, entirely independent of
// anything this app's own limiter (src/index.ts) does. GET /api/artists/:id
// in particular fans out to dozens of parallel Spotify calls for a single
// page load -- one albums-list call, one call per album (up to 10), one call
// per track (up to ARTIST_PROFILE_TRACK_MAX_LIMIT, since Spotify's batch
// tracks endpoint 403s for this app -- see fetchTracksByIds below) -- which
// is exactly the kind of burst that trips it. GET /api/artists/search, by
// contrast, makes exactly one Spotify call, which is why "search works but
// loading an artist doesn't" was the reported symptom rather than a general
// outage.
//
// Every Spotify call in this file goes through this instead of a raw
// fetch(): a 429 gets a few bounded retries with exponential backoff,
// honoring Spotify's own Retry-After header when present. Still 429 after
// every attempt throws SpotifyRateLimitError specifically (see above)
// rather than the generic "... fetch failed: 429 ..." Error every other
// failure throws.
//
// Raised from a single retry -- production kept surfacing
// SpotifyRateLimitError (the "Spotify's a little busy" 503) even after that
// one short retry, meaning Spotify's own limit window can outlast a single
// ~1-2s backoff. SPOTIFY_MAX_RETRIES=3 (4 attempts total) with the delay
// doubling each time gives a real fan-out (GET /api/artists/:id, up to ~40
// calls) meaningfully more runway to clear Spotify's window before this
// gives up and reports the honest "still limited" error.
const SPOTIFY_MAX_RETRIES = 3;
const SPOTIFY_RETRY_MAX_DELAY_MS = 4000;
const SPOTIFY_RETRY_DEFAULT_DELAY_MS = 1000;

// Spotify's documented rate limit window is a rolling 30 seconds
// (https://developer.spotify.com/documentation/web-api/concepts/rate-limits).
// A real Retry-After far beyond that isn't a normal short-term throttle --
// it's Spotify's Development Mode extended-quota/anti-abuse penalty.
// Confirmed live in production: Retry-After values of ~54800s (~15 hours)
// on catalog detail endpoints (GET /v1/artists/{id}, /v1/albums/{id}/tracks),
// matching widely-reported community experience (12-24+ hour penalties --
// see https://community.spotify.com/t5/Spotify-for-Developers/Very-long-Retry-After-values-on-Web-API-429/td-p/7432857
// and https://community.spotify.com/t5/Spotify-for-Developers/Rate-limit-unreasonably-high-after-one-single-429-response/td-p/5880001).
// Retrying against one of those doesn't just waste ~12s per attempt for
// nothing -- community reports say continuing to send requests before an
// active long Retry-After elapses can extend the penalty further. So this
// function gives up immediately, no retries at all, the moment any 429's
// real Retry-After crosses this threshold, for both interactive and
// background calls alike -- there is no scenario where retrying against an
// hours-long block is the right call.
const SPOTIFY_RETRY_ABANDON_THRESHOLD_SECONDS = 60;

// A real Spotify-specified value (Retry-After present and valid) vs. the
// absence of one -- null, not NaN/0, so it's unambiguous in the structured
// log below (spotifyFetch's own comment) and in markSpotifyCooldown's
// undefined-means-use-the-default contract.
function parseRetryAfterSeconds(res: Response): number | null {
  const header = res.headers.get('Retry-After');
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

async function spotifyFetch(url: string, options: RequestInit = {}, kv?: KVNamespace): Promise<Response> {
  const startedAt = Date.now();
  let res = await fetch(url, options);
  let attempts = 1;
  // Captured right after the first fetch, before the retry loop below can
  // overwrite `res` -- the loop only ever runs while res.status === 429, so
  // this single check at the top fully captures "was a 429 seen at all"
  // across the whole call, retries included.
  const rateLimited = res.status === 429;
  // One entry per 429 response actually seen (up to SPOTIFY_MAX_RETRIES + 1)
  // -- logged verbatim below so a real, larger Retry-After value Spotify
  // sends can be told apart from SPOTIFY_RETRY_MAX_DELAY_MS silently
  // truncating it, instead of inferring that from total call duration.
  const retryAfterSecondsSeen: Array<number | null> = [];
  if (rateLimited) retryAfterSecondsSeen.push(parseRetryAfterSeconds(res));

  // Reported the moment ANY call actually sees a 429 -- the earliest, most
  // actionable signal that Spotify is currently constrained -- before this
  // function's own retry loop even runs. Only when a kv is provided: the
  // handful of Spotify calls outside the artist-tracks fan-out
  // (login/profile/top-tracks/single-item search) don't pass one and keep
  // their exact pre-existing behavior.
  if (res.status === 429 && kv) {
    await markSpotifyCooldown(kv, retryAfterSecondsSeen[0] ?? undefined);
  }

  for (
    let attempt = 0;
    attempt < SPOTIFY_MAX_RETRIES &&
    res.status === 429 &&
    (retryAfterSecondsSeen[retryAfterSecondsSeen.length - 1] ?? 0) <= SPOTIFY_RETRY_ABANDON_THRESHOLD_SECONDS;
    attempt++
  ) {
    const retryAfterSeconds = retryAfterSecondsSeen[retryAfterSecondsSeen.length - 1];
    const delayMs = Math.min(
      retryAfterSeconds != null ? retryAfterSeconds * 1000 : SPOTIFY_RETRY_DEFAULT_DELAY_MS * 2 ** attempt,
      SPOTIFY_RETRY_MAX_DELAY_MS
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res = await fetch(url, options);
    attempts += 1;
    if (res.status === 429) retryAfterSecondsSeen.push(parseRetryAfterSeconds(res));
  }

  // A structured object (not a template string) so Cloudflare Workers Logs
  // auto-extracts these as indexed, filterable fields -- lets every Spotify
  // call across the whole app (web requests, the backfill queue consumer,
  // the deck top-up job, the admin seed script) be watched centrally via
  // `wrangler tail --search spotify_call` or Logs Explorer, regardless of
  // which of the ~15 functions in this file ultimately triggered it. Logged
  // before the 429-exhausted throw below, not after, so a call that
  // ultimately fails still shows up.
  console.log({
    type: 'spotify_call',
    url,
    method: options.method ?? 'GET',
    status: res.status,
    attempts,
    durationMs: Date.now() - startedAt,
    rateLimited,
    retryAfterSeconds: retryAfterSecondsSeen,
  });

  if (res.status === 429) {
    throw new SpotifyRateLimitError(`Spotify rate-limited this request even after ${SPOTIFY_MAX_RETRIES} retries: ${url}`);
  }
  return res;
}

// Caps how many individual GET /v1/tracks/{id} calls (fetchTracksByIds,
// below) are ever in flight at once. Firing all of them -- up to
// ARTIST_PROFILE_TRACK_MAX_LIMIT (90, src/routes/catalog.ts) -- as one
// simultaneous Promise.all was the single biggest contributor to tripping
// Spotify's own rate limit: a burst far beyond anything a normal page load
// should need to send at once. Batching keeps the peak burst size bounded
// without falling back to a fully sequential (much slower) loop.
const TRACK_FETCH_CONCURRENCY = 5;

// Same reasoning as TRACK_FETCH_CONCURRENCY, applied to fetchArtistTracks'
// other fan-out: fetchAlbumTrackIds (below) used to fire once per album --
// up to ARTIST_ALBUMS_PAGE_SIZE (10) -- as one simultaneous Promise.all.
// Smaller than TRACK_FETCH_CONCURRENCY only because it never has as many
// items to bound in the first place (max 10 vs. up to 90); the point is the
// same, keep every phase of the pipeline's peak burst bounded, not just the
// track-detail phase.
const ALBUM_TRACKS_FETCH_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>, delayMs = 0): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
      if (delayMs > 0 && nextIndex < items.length) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// streaming/user-read-playback-state/user-modify-playback-state back the
// Wavelengthz Player (public/wavelengthzPlayer.js, src/routes/player.ts) --
// the Spotify Web Playback SDK, which plays a full track in-page via a
// browser-side Spotify Connect device instead of the read-only
// open.spotify.com/embed iframe (public/artist.html et al). user-read-private
// is required for a different reason: Spotify's /v1/me response only
// includes the `product` field (fetchSpotifyProfile below, stored as
// music_source_tokens.product_tier) when this scope was granted -- without
// it `product` is silently omitted, not "free", so player.ts's premium gate
// fails for every account regardless of actual tier. Adding scopes here
// only affects *new* consents (this app's own registered redirect_uri going
// forward) -- every already-logged-in user's existing token keeps whatever
// scope they originally consented to until their next full /login, since a
// refresh can't silently grant scopes never approved.
const SCOPES = [
  'user-top-read',
  'user-read-email',
  'user-read-private',
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

// redirectUri defaults to env.SPOTIFY_REDIRECT_URI, but callers on an
// allowlisted alternate host (src/routes/auth.ts's SPOTIFY_ALLOWED_HOSTS)
// pass their own host's callback URL instead -- Spotify's token exchange
// later requires an exact match against whichever one was used here.
export function buildAuthUrl(state: string, env: Env, redirectUri: string = env.SPOTIFY_REDIRECT_URI): string {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('client_id', env.SPOTIFY_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

function basicAuthHeader(env: Env): string {
  return 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
}

export async function exchangeCodeForToken(
  code: string,
  env: Env,
  redirectUri: string = env.SPOTIFY_REDIRECT_URI
): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await spotifyFetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(env),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`Spotify token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function refreshAccessToken(
  refreshToken: string,
  env: Env
): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await spotifyFetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(env),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`Spotify token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json<SpotifyTokenResponse>();
  return { ...data, refresh_token: data.refresh_token ?? refreshToken };
}

export async function fetchSpotifyProfile(
  accessToken: string
): Promise<{ id: string; email?: string; images?: Array<{ url: string }>; product?: string }> {
  const res = await spotifyFetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Spotify profile fetch failed: ${res.status} ${await res.text()}`);
  // `product` is Spotify's own subscription-tier field: "premium" | "free" |
  // occasionally "open" (a legacy ad-supported tier in some regions,
  // functionally equivalent to free). Refreshed on every login (not just
  // once) since it can genuinely change over time as a user upgrades/downgrades.
  // Spotify omits this field entirely unless the access token carries the
  // user-read-private scope (see SCOPES above) -- without it, this comes
  // back undefined even for a Premium account.
  return res.json();
}

export async function fetchTopArtists(
  accessToken: string,
  timeRange: string
): Promise<Array<{ id: string; name: string; genres: string[]; imageUrl: string | null; rank: number }>> {
  const res = await spotifyFetch(
    `https://api.spotify.com/v1/me/top/artists?time_range=${timeRange}&limit=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Spotify top artists fetch failed: ${res.status} ${await res.text()}`);
  // Spotify's response sometimes omits `genres` entirely for a given artist
  // (not even an empty array) despite the documented shape always including
  // it -- normalize here so every consumer can rely on it being an array.
  const data = await res.json<{ items: Array<{ id: string; name: string; genres?: string[]; images?: Array<{ url: string }> }> }>();
  return data.items.map((item, i) => ({
    id: item.id,
    name: item.name,
    genres: item.genres ?? [],
    imageUrl: item.images?.[0]?.url ?? null,
    rank: i + 1,
  }));
}

export async function fetchTopTracks(
  accessToken: string,
  timeRange: string
): Promise<Array<{ id: string; name: string; imageUrl: string | null; rank: number }>> {
  const res = await spotifyFetch(
    `https://api.spotify.com/v1/me/top/tracks?time_range=${timeRange}&limit=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Spotify top tracks fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ items: Array<{ id: string; name: string; album?: { images?: Array<{ url: string }> } }> }>();
  return data.items.map((item, i) => ({
    id: item.id,
    name: item.name,
    imageUrl: item.album?.images?.[0]?.url ?? null,
    rank: i + 1,
  }));
}

export async function getClientCredentialsToken(env: Env): Promise<string> {
  const res = await spotifyFetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Spotify client-credentials fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ access_token: string }>();
  return data.access_token;
}

export async function searchArtistsByGenre(token: string, genre: string, limit: number, offset: number, kv: KVNamespace) {
  const cooldownMs = await isSpotifyCoolingDown(kv);
  if (cooldownMs !== null) throw new SpotifyCooldownActiveError(cooldownMs);

  const res = await spotifyFetch(
    `https://api.spotify.com/v1/search?type=artist&limit=${limit}&offset=${offset}&q=${encodeURIComponent(`genre:"${genre}"`)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    kv
  );
  if (!res.ok) throw new Error(`Spotify artist search failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ artists: { items: any[] } }>();
  return data.artists.items;
}

// Spotify's dedicated "Get Artist's Top Tracks" endpoint (GET
// /v1/artists/{id}/top-tracks) now returns a blanket 403 Forbidden for this
// app -- confirmed directly against the live API (every artist tried, both
// with a client-credentials token and a real user token). This is Spotify's
// February 2026 Web API change, which removed the endpoint entirely for apps
// in Development Mode (not the earlier Nov 2024 round, which only hit
// Related Artists/Recommendations/Audio Features/Analysis). It's a hard
// removal, not a smaller result set or a client-credentials-only gap -- the
// only way back is Extended Quota Mode (see docs/spotify-extended-quota.md),
// which needs an approved org + 250k+ MAU we don't have yet.
//
// The previous fallback (GET /v1/search?type=track&q=artist:"NAME", filtered
// down to results whose `artists` list actually contains the artist id) is
// itself unreliable enough to come back completely empty for some real
// artists -- confirmed live against the API for "Cirez D" (Eric Prydz's
// alias): the exact query artist:"Cirez D" returns 10 results, and Spotify's
// search index attributes every single one to Eric Prydz's mainline
// catalog, with zero Cirez D credit on any of them. Filtering correctly
// rejects all 10 (they're genuinely the wrong artist), leaving nothing --
// "No tracks found" isn't a bug in the filter, it's this endpoint being
// unable to find the artist's own tracks at all once fuzzy name matching
// gets captured by a more famous associated identity.
//
// GET /v1/artists/{id}/albums -> GET /v1/albums/{id}/tracks is id-scoped
// end to end -- no text matching, no alias ambiguity, and (unlike top-tracks)
// not restricted in Development Mode. Verified live: this returns Cirez D's
// actual discography (Valborg/The Raid, DARE U, Mokba, ...) with every track
// correctly credited to Cirez D.
// Spotify's real max for this endpoint's `limit` is 10, not the more
// commonly-assumed higher ceilings that apply to some of its other
// list endpoints -- confirmed directly against the current API docs.
const ARTIST_ALBUMS_PAGE_SIZE = 10;
// Spotify's real max for this endpoint's `limit` is 50.
const ALBUM_TRACKS_PAGE_SIZE = 50;

async function fetchArtistAlbumIds(token: string, artistId: string, limit: number, kv?: KVNamespace): Promise<string[]> {
  const res = await spotifyFetch(
    // include_groups excludes "compilation" and "appears_on" -- releases
    // where this artist isn't the actual album artist, which is exactly the
    // ambiguity this replaces the name-search fallback to avoid.
    `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single&limit=${Math.min(limit, ARTIST_ALBUMS_PAGE_SIZE)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    kv
  );
  if (!res.ok) throw new Error(`Spotify artist albums fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ items: Array<{ id: string }> }>();
  return data.items.map((album) => album.id);
}

async function fetchAlbumTrackIds(token: string, albumId: string, limit: number, kv?: KVNamespace): Promise<string[]> {
  const res = await spotifyFetch(
    `https://api.spotify.com/v1/albums/${albumId}/tracks?limit=${Math.min(limit, ALBUM_TRACKS_PAGE_SIZE)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    kv
  );
  if (!res.ok) throw new Error(`Spotify album tracks fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ items: Array<{ id: string }> }>();
  return data.items.map((track) => track.id);
}

async function fetchTracksByIds(token: string, trackIds: string[], kv?: KVNamespace, delayMs = 0) {
  // GET /v1/albums/{id}/tracks returns simplified track objects with no
  // `album` field, so no album art -- full details come from fetchTrackById
  // instead. The batch form of this lookup (GET /v1/tracks?ids=, plural)
  // also 403s in Development Mode -- confirmed live, even with a single id
  // -- while the singular GET /v1/tracks/{id} used here works fine, so this
  // is one request per track rather than one batch request. Bounded by
  // TRACK_FETCH_CONCURRENCY (see its own comment) rather than one giant
  // Promise.all -- with no batch endpoint available, a large track count
  // (up to ARTIST_PROFILE_TRACK_MAX_LIMIT) firing every request at once was
  // the single biggest contributor to tripping Spotify's own rate limit.
  // One id failing (removed/region-locked track) shouldn't drop the rest of
  // the artist's tracks, so each fetch is isolated via .catch rather than
  // one throw wiping out the whole batch.
  const results = await mapWithConcurrency(
    trackIds,
    TRACK_FETCH_CONCURRENCY,
    (id) => fetchTrackById(token, id, kv).catch(() => null),
    delayMs
  );
  return results.filter((track): track is NonNullable<typeof track> => track != null);
}

// Conservative starting guess for spacing out a background-priority
// fan-out's individual Spotify calls -- same total call count as today, but
// spread over more wall-clock time so it doesn't cluster inside whatever
// Spotify's real rolling rate-limit window turns out to be (see
// src/lib/spotifyThrottle.ts's own comment). Interactive-priority calls
// never use this -- a real user is waiting on those.
const SPOTIFY_BACKGROUND_PACING_DELAY_MS = 250;

// Only used for 'background'-priority fetchArtistTracks calls (the backfill
// queue consumer, the deck's candidate top-up) -- fetches albums' track-ID
// lists in ALBUM_TRACKS_FETCH_CONCURRENCY-sized chunks instead of one
// mapWithConcurrency call across all (up to 10) albums, stopping as soon as
// `limit` track ids have been gathered. The interactive branch below
// deliberately keeps fetching everything up front (see its own comment) --
// this early-stop only makes sense once nothing is waiting on the result.
async function gatherAlbumTrackIdsForBackground(
  token: string,
  albumIds: string[],
  limit: number,
  kv: KVNamespace | undefined
): Promise<string[]> {
  const collected: string[] = [];
  for (let i = 0; i < albumIds.length && collected.length < limit; i += ALBUM_TRACKS_FETCH_CONCURRENCY) {
    const chunk = albumIds.slice(i, i + ALBUM_TRACKS_FETCH_CONCURRENCY);
    const chunkResults = await mapWithConcurrency(chunk, ALBUM_TRACKS_FETCH_CONCURRENCY, (albumId) =>
      fetchAlbumTrackIds(token, albumId, limit, kv)
    );
    collected.push(...chunkResults.flat());
    const hasMoreAlbums = i + ALBUM_TRACKS_FETCH_CONCURRENCY < albumIds.length;
    if (collected.length < limit && hasMoreAlbums) {
      await new Promise((resolve) => setTimeout(resolve, SPOTIFY_BACKGROUND_PACING_DELAY_MS));
    }
  }
  return collected;
}

export async function fetchArtistTracks(
  token: string,
  artistId: string,
  limit: number,
  priority: 'interactive' | 'background' = 'interactive',
  kv?: KVNamespace
) {
  if (priority === 'background') {
    if (!kv) throw new Error('fetchArtistTracks: kv is required when priority is "background"');
    const cooldownMs = await isSpotifyCoolingDown(kv);
    if (cooldownMs !== null) throw new SpotifyCooldownActiveError(cooldownMs);
  }

  // Fetched in parallel, not stopping early once enough tracks are found in
  // earlier albums -- a handful of extra album-tracks calls (bounded by
  // ARTIST_ALBUMS_PAGE_SIZE, at most 10) is a better trade than sequential
  // round trips directly adding to page load latency. Still capped by the
  // caller's own `limit` too (via fetchArtistAlbumIds's Math.min), so a
  // small target -- e.g. artistTopUp.ts's TRACKS_PER_ARTIST -- doesn't fan
  // out to 10 albums' worth of calls just to keep 2 tracks. Album order
  // (most recent release first -- see the module comment above) is
  // preserved via .flat(), so the truncation below still favors newer
  // releases. This trade-off (fetch everything up front) is interactive-only
  // -- 'background' priority uses gatherAlbumTrackIdsForBackground instead,
  // since nothing is waiting on a background job's latency.
  const albumIds = await fetchArtistAlbumIds(token, artistId, limit, kv);

  let trackIds: string[];
  if (priority === 'background') {
    trackIds = (await gatherAlbumTrackIdsForBackground(token, albumIds, limit, kv)).slice(0, limit);
  } else {
    const albumTrackIdLists = await mapWithConcurrency(albumIds, ALBUM_TRACKS_FETCH_CONCURRENCY, (albumId) =>
      fetchAlbumTrackIds(token, albumId, limit, kv)
    );
    trackIds = albumTrackIdLists.flat().slice(0, limit);
  }

  const tracks = await fetchTracksByIds(token, trackIds, kv, priority === 'background' ? SPOTIFY_BACKGROUND_PACING_DELAY_MS : 0);
  // Belt-and-suspenders: a release where this artist is the album artist
  // should credit them on every track, but this costs nothing and matches
  // the same defensive check the old search-based path needed for real.
  return tracks.filter((track) => track.artists?.some((a: any) => a.id === artistId));
}

// Only the single most recent release, and only enough tracks from it to
// show something -- not fetchArtistTracks' full ~10-album/~40-call fan-out.
// Exists for GET /api/artists/:id's first (no ?limit=) view of a brand-new
// artist specifically: the full fan-out was what tripped Spotify's own rate
// limit under real load even after retries/concurrency-capping/caching
// (see fetchArtistTracks' own comment above, and src/lib/artistTrackBackfill.ts,
// which fetches the rest of this same artist's discography off the request
// path once this quick response has already gone out).
const QUICK_ALBUM_LIMIT = 1;
export const QUICK_TRACK_LIMIT = 5;

export async function fetchArtistTracksQuick(
  token: string,
  artistId: string,
  kv?: KVNamespace,
  trackCount: number = QUICK_TRACK_LIMIT
) {
  const albumIds = await fetchArtistAlbumIds(token, artistId, QUICK_ALBUM_LIMIT, kv);
  if (albumIds.length === 0) return [];

  // Sliced client-side after the call, not just trusted to the endpoint's
  // own `?limit=` (which fetchAlbumTrackIds does pass) -- keeps this
  // function's actual Spotify-call count deterministic regardless of how
  // many tracks come back, the same defense-in-depth reasoning as
  // fetchArtistTracks' own `.slice(0, limit)` above.
  const trackIds = (await fetchAlbumTrackIds(token, albumIds[0], trackCount, kv)).slice(0, trackCount);
  const tracks = await fetchTracksByIds(token, trackIds, kv);
  return tracks.filter((track) => track.artists?.some((a: any) => a.id === artistId));
}

export async function searchArtistsByName(token: string, query: string, limit: number) {
  const res = await spotifyFetch(
    `https://api.spotify.com/v1/search?type=artist&limit=${limit}&q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Spotify artist search failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ artists: { items: any[] } }>();
  return data.artists.items;
}

export async function fetchArtistById(token: string, artistId: string) {
  const res = await spotifyFetch(`https://api.spotify.com/v1/artists/${artistId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify artist fetch failed: ${res.status} ${await res.text()}`);
  return res.json<any>();
}

export async function searchTracksByArtist(token: string, artistName: string, trackQuery: string, limit: number) {
  const q = `artist:${artistName} track:${trackQuery}`;
  const res = await spotifyFetch(
    `https://api.spotify.com/v1/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Spotify track search failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ tracks: { items: any[] } }>();
  return data.tracks.items;
}

export async function fetchTrackById(token: string, trackId: string, kv?: KVNamespace) {
  const res = await spotifyFetch(
    `https://api.spotify.com/v1/tracks/${trackId}`,
    { headers: { Authorization: `Bearer ${token}` } },
    kv
  );
  if (!res.ok) throw new Error(`Spotify track fetch failed: ${res.status} ${await res.text()}`);
  return res.json<any>();
}
