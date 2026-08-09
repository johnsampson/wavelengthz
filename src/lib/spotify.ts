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

// streaming/user-read-playback-state/user-modify-playback-state back the
// Wavelengthz Player (public/wavelengthzPlayer.js, src/routes/player.ts) --
// the Spotify Web Playback SDK, which plays a full track in-page via a
// browser-side Spotify Connect device instead of the read-only
// open.spotify.com/embed iframe (public/artist.html et al). Adding scopes
// here only affects *new* consents (this app's own registered redirect_uri
// going forward) -- every already-logged-in user's existing token keeps
// whatever scope they originally consented to until their next full
// /login, since a refresh can't silently grant scopes never approved.
const SCOPES = [
  'user-top-read',
  'user-read-email',
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
  const res = await fetch('https://accounts.spotify.com/api/token', {
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
  const res = await fetch('https://accounts.spotify.com/api/token', {
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
  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Spotify profile fetch failed: ${res.status} ${await res.text()}`);
  // `product` is Spotify's own subscription-tier field: "premium" | "free" |
  // occasionally "open" (a legacy ad-supported tier in some regions,
  // functionally equivalent to free). Refreshed on every login (not just
  // once) since it can genuinely change over time as a user upgrades/downgrades.
  return res.json();
}

export async function fetchTopArtists(
  accessToken: string,
  timeRange: string
): Promise<Array<{ id: string; name: string; genres: string[]; imageUrl: string | null; rank: number }>> {
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch('https://accounts.spotify.com/api/token', {
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

export async function searchArtistsByGenre(token: string, genre: string, limit: number, offset = 0) {
  const res = await fetch(
    `https://api.spotify.com/v1/search?type=artist&limit=${limit}&offset=${offset}&q=${encodeURIComponent(`genre:"${genre}"`)}`,
    { headers: { Authorization: `Bearer ${token}` } }
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

async function fetchArtistAlbumIds(token: string, artistId: string, limit: number): Promise<string[]> {
  const res = await fetch(
    // include_groups excludes "compilation" and "appears_on" -- releases
    // where this artist isn't the actual album artist, which is exactly the
    // ambiguity this replaces the name-search fallback to avoid.
    `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single&limit=${Math.min(limit, ARTIST_ALBUMS_PAGE_SIZE)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Spotify artist albums fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ items: Array<{ id: string }> }>();
  return data.items.map((album) => album.id);
}

async function fetchAlbumTrackIds(token: string, albumId: string, limit: number): Promise<string[]> {
  const res = await fetch(`https://api.spotify.com/v1/albums/${albumId}/tracks?limit=${Math.min(limit, ALBUM_TRACKS_PAGE_SIZE)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify album tracks fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ items: Array<{ id: string }> }>();
  return data.items.map((track) => track.id);
}

async function fetchTracksByIds(token: string, trackIds: string[]) {
  // GET /v1/albums/{id}/tracks returns simplified track objects with no
  // `album` field, so no album art -- full details come from fetchTrackById
  // instead. The batch form of this lookup (GET /v1/tracks?ids=, plural)
  // also 403s in Development Mode -- confirmed live, even with a single id
  // -- while the singular GET /v1/tracks/{id} used here works fine, so this
  // is one request per track rather than one batch request. Fetched in
  // parallel (not a sequential loop) -- with no batch endpoint available,
  // sequential per-track fetches would make a larger track count directly
  // slow down the artist-profile page load, one Spotify round trip at a
  // time. One id failing (removed/region-locked track) shouldn't drop the
  // rest of the artist's tracks, so each fetch is isolated via .catch
  // rather than one throw wiping out the whole batch.
  const results = await Promise.all(trackIds.map((id) => fetchTrackById(token, id).catch(() => null)));
  return results.filter((track): track is NonNullable<typeof track> => track != null);
}

export async function fetchArtistTracks(token: string, artistId: string, limit: number) {
  // Fetched in parallel, not stopping early once enough tracks are found in
  // earlier albums -- a handful of extra album-tracks calls (bounded by
  // ARTIST_ALBUMS_PAGE_SIZE, at most 10) is a better trade than sequential
  // round trips directly adding to page load latency. Still capped by the
  // caller's own `limit` too (via fetchArtistAlbumIds's Math.min), so a
  // small target -- e.g. artistTopUp.ts's TRACKS_PER_ARTIST -- doesn't fan
  // out to 10 albums' worth of calls just to keep 2 tracks. Album order
  // (most recent release first -- see the module comment above) is
  // preserved via .flat(), so the truncation below still favors newer
  // releases.
  const albumIds = await fetchArtistAlbumIds(token, artistId, limit);
  const albumTrackIdLists = await Promise.all(albumIds.map((albumId) => fetchAlbumTrackIds(token, albumId, limit)));
  const trackIds = albumTrackIdLists.flat().slice(0, limit);
  const tracks = await fetchTracksByIds(token, trackIds);
  // Belt-and-suspenders: a release where this artist is the album artist
  // should credit them on every track, but this costs nothing and matches
  // the same defensive check the old search-based path needed for real.
  return tracks.filter((track) => track.artists?.some((a: any) => a.id === artistId));
}

export async function searchArtistsByName(token: string, query: string, limit: number) {
  const res = await fetch(
    `https://api.spotify.com/v1/search?type=artist&limit=${limit}&q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Spotify artist search failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ artists: { items: any[] } }>();
  return data.artists.items;
}

export async function fetchArtistById(token: string, artistId: string) {
  const res = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify artist fetch failed: ${res.status} ${await res.text()}`);
  return res.json<any>();
}

export async function searchTracksByArtist(token: string, artistName: string, trackQuery: string, limit: number) {
  const q = `artist:${artistName} track:${trackQuery}`;
  const res = await fetch(
    `https://api.spotify.com/v1/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Spotify track search failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ tracks: { items: any[] } }>();
  return data.tracks.items;
}

export async function fetchTrackById(token: string, trackId: string) {
  const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify track fetch failed: ${res.status} ${await res.text()}`);
  return res.json<any>();
}
