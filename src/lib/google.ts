export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
}

const SCOPES = ['openid', 'email', 'profile'].join(' ');

export function buildGoogleAuthUrl(state: string, env: Env, redirectUri: string = env.GOOGLE_REDIRECT_URI): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  // Round 8 (issue #173): without this, Google silently reuses whatever
  // Google account is already active in the browser and skips its own
  // account picker -- fine for the common case, but it means there was no
  // way to sign in with a *different* Google account without first fully
  // signing out of Google itself in that browser. `select_account` forces
  // Google's chooser on every login attempt (still just one click if
  // there's only one account, or the user picks the same one again), which
  // is what actually lets an admin test multiple accounts and doubles as a
  // reasonable general default against "I got logged into the wrong
  // Google account" confusion.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

// Google's token endpoint takes client_id/client_secret in the request body
// (form-encoded), not a Basic auth header -- this is Google's documented
// standard, unlike Spotify's Basic-auth convention in src/lib/spotify.ts.
export async function exchangeGoogleCode(
  code: string,
  env: Env,
  redirectUri: string = env.GOOGLE_REDIRECT_URI
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function fetchGoogleProfile(
  accessToken: string
): Promise<{ sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }> {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google profile fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}
