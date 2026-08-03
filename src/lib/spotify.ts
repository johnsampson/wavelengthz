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
  if (!res.ok) throw new Error(`Spotify token exchange failed: ${res.status}`);
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
  if (!res.ok) throw new Error(`Spotify token refresh failed: ${res.status}`);
  const data = await res.json<SpotifyTokenResponse>();
  return { ...data, refresh_token: data.refresh_token ?? refreshToken };
}

export async function fetchSpotifyProfile(
  accessToken: string
): Promise<{ id: string; email?: string }> {
  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Spotify profile fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchTopArtists(
  accessToken: string,
  timeRange: string
): Promise<Array<{ id: string; name: string; genres: string[]; rank: number }>> {
  const res = await fetch(
    `https://api.spotify.com/v1/me/top/artists?time_range=${timeRange}&limit=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Spotify top artists fetch failed: ${res.status}`);
  const data = await res.json<{ items: Array<{ id: string; name: string; genres: string[] }> }>();
  return data.items.map((item, i) => ({ ...item, rank: i + 1 }));
}

export async function fetchTopTracks(
  accessToken: string,
  timeRange: string
): Promise<Array<{ id: string; name: string; rank: number }>> {
  const res = await fetch(
    `https://api.spotify.com/v1/me/top/tracks?time_range=${timeRange}&limit=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Spotify top tracks fetch failed: ${res.status}`);
  const data = await res.json<{ items: Array<{ id: string; name: string }> }>();
  return data.items.map((item, i) => ({ ...item, rank: i + 1 }));
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
  if (!res.ok) throw new Error(`Spotify client-credentials fetch failed: ${res.status}`);
  const data = await res.json<{ access_token: string }>();
  return data.access_token;
}

export async function searchArtistsByGenre(token: string, genre: string, limit: number) {
  const res = await fetch(
    `https://api.spotify.com/v1/search?type=artist&limit=${limit}&q=${encodeURIComponent(`genre:"${genre}"`)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Spotify artist search failed: ${res.status}`);
  const data = await res.json<{ artists: { items: any[] } }>();
  return data.artists.items;
}

export async function fetchArtistTopTracks(token: string, artistId: string, market = 'US') {
  const res = await fetch(
    `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=${market}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Spotify top tracks (artist) fetch failed: ${res.status}`);
  const data = await res.json<{ tracks: any[] }>();
  return data.tracks;
}
