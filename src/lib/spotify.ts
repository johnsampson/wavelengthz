export interface SpotifyTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const SCOPES = ['user-top-read', 'user-read-email'].join(' ');

export function buildAuthUrl(state: string, env: Env): string {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('client_id', env.SPOTIFY_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.SPOTIFY_REDIRECT_URI);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

function basicAuthHeader(env: Env): string {
  return 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
}

export async function exchangeCodeForToken(
  code: string,
  env: Env
): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
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
// with a client-credentials token and a real user token), consistent with
// Spotify having moved that endpoint behind Extended Quota Mode access that
// this app doesn't have. There is no token or scope that fixes this from our
// side, so this falls back to the still-open track search endpoint instead,
// searching by artist name rather than id.
export async function searchTracksByArtistName(token: string, artistName: string, limit: number) {
  const res = await fetch(
    `https://api.spotify.com/v1/search?type=track&limit=${limit}&q=${encodeURIComponent(`artist:"${artistName}"`)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Spotify track search (by artist name) failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ tracks: { items: any[] } }>();
  return data.tracks.items;
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
