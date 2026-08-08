import type { IRequest, RouterType } from 'itty-router';
import { buildAuthUrl, exchangeCodeForToken, fetchSpotifyProfile } from '../lib/spotify';
import { encrypt } from '../lib/crypto';
import { createSession, requestIsSecure, requestProtocol, getSessionUser } from '../lib/session';
import { buildGoogleAuthUrl } from '../lib/google';

function parseCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

// Hosts OAuth can run on directly: SPOTIFY_REDIRECT_URI's own host, plus
// anything explicitly opted into via SPOTIFY_ALLOWED_HOSTS (comma-separated,
// e.g. a Cloudflare Tunnel hostname for testing on a real phone). This is an
// explicit allowlist, not "trust whatever Host header shows up" -- Spotify
// enforces its own exact-match allowlist of registered redirect URIs
// regardless, but blindly trusting the request's own host here would still
// let this app hand out an oauth-state cookie (and construct a redirect_uri
// sent to Spotify) for literally any host that reaches it, which is a wider
// trust surface than intended, not a wider capability than Spotify allows.
function isAllowedHost(host: string, env: Env): boolean {
  if (host === new URL(env.SPOTIFY_REDIRECT_URI).host) return true;
  return (env.SPOTIFY_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .includes(host);
}

function callbackUrlForHost(protocol: string, host: string): string {
  return `${protocol}//${host}/callback`;
}

export function registerAuthRoutes(router: RouterType) {
  router.get('/login/spotify', async (request: IRequest, env: Env) => {
    // The state cookie set below is host-scoped, but Spotify always redirects
    // back to whatever host the redirect_uri we send it names -- if /login is
    // reached via a host that isn't allowed to complete OAuth (see
    // isAllowedHost above; classically "localhost" vs "127.0.0.1":
    // `wrangler dev` itself prints "Ready on http://localhost:8787" on every
    // single restart, while SPOTIFY_REDIRECT_URI is configured as 127.0.0.1),
    // a cookie set here would never be sent back on the callback, producing
    // "Invalid OAuth state" 100% of the time with nothing actually wrong
    // server-side. Funnel onto the canonical host first, before ever setting
    // the cookie.
    const url = new URL(request.url);
    if (!isAllowedHost(url.host, env)) {
      const redirectUri = new URL(env.SPOTIFY_REDIRECT_URI);
      url.protocol = redirectUri.protocol;
      url.host = redirectUri.host;
      return new Response(null, { status: 302, headers: { Location: url.toString() } });
    }

    const state = crypto.randomUUID();
    // requestProtocol, not url.protocol: see the comment on requestIsSecure
    // in session.ts -- a Cloudflare Tunnel to a local instance reports http
    // here even when the public/browser side is https, and Spotify rejects
    // a non-loopback http redirect_uri outright.
    const authUrl = buildAuthUrl(state, env, callbackUrlForHost(requestProtocol(request), url.host));
    const secure = requestIsSecure(request);

    // ?intent=connect (from Settings' "Connect Spotify" action) marks this as
    // linking to the currently logged-in user rather than a fresh login --
    // /callback reads this cookie to decide which path to take.
    const headers = new Headers({ Location: authUrl });
    headers.append('Set-Cookie', `wl_oauth_state=${state}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=600`);
    if (url.searchParams.get('intent') === 'connect') {
      headers.append('Set-Cookie', `wl_oauth_intent=connect; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=600`);
    }
    return new Response(null, { status: 302, headers });
  });

  router.get('/login/google', async (request: IRequest, env: Env) => {
    const state = crypto.randomUUID();
    const authUrl = buildGoogleAuthUrl(state, env);
    const secure = requestIsSecure(request);
    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl,
        'Set-Cookie': `wl_oauth_state=${state}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=600`,
      },
    });
  });

  router.get('/callback', async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieState = parseCookie(request, 'wl_oauth_state');

    if (!code || !state || !cookieState || state !== cookieState) {
      return new Response('Invalid OAuth state', { status: 400 });
    }

    // The redirect_uri sent here must exactly match whichever one /login
    // used to start this flow -- which, since Spotify only ever redirects
    // back to a host it was actually told to, is this request's own host
    // whenever that host is allowed (falling back to the configured default
    // is just defensive; a callback landing on a non-allowed host shouldn't
    // happen in practice).
    const redirectUri = isAllowedHost(url.host, env) ? callbackUrlForHost(requestProtocol(request), url.host) : env.SPOTIFY_REDIRECT_URI;
    const token = await exchangeCodeForToken(code, env, redirectUri);
    const profile = await fetchSpotifyProfile(token.access_token);

    const encryptedAccess = await encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY);
    const encryptedRefresh = await encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY);
    const now = Date.now();
    const expiresAt = now + token.expires_in * 1000;
    const avatarUrl = profile.images?.[0]?.url ?? null;
    const product = profile.product ?? null;

    // Deliberately not filtered by deleted_at IS NULL: (provider, provider_id) is
    // UNIQUE, so a soft-deleted row's identity permanently occupies that Spotify
    // account's slot. Signing back in during the grace period (before the nightly
    // hard-delete purge) reactivates the account below rather than leaving it
    // stuck -- found with deleted_at still set, but with no way to ever pass
    // getSessionUser's deleted_at IS NULL check, and no way to re-register the
    // same Spotify account as "new" either.
    const existingIdentity = await env.DB.prepare(
      `SELECT ai.user_id, u.onboarded_at FROM auth_identities ai
       JOIN users u ON u.id = ai.user_id
       WHERE ai.provider = 'spotify' AND ai.provider_id = ?`
    )
      .bind(profile.id)
      .first<{ user_id: string; onboarded_at: number | null }>();

    let userId: string;
    let onboarded: boolean;

    const tokenStatement = (uid: string) =>
      env.DB.prepare(
        `INSERT INTO music_source_tokens (id, user_id, provider, provider_user_id, access_token, refresh_token, token_expires_at, avatar_url, product_tier, created_at, updated_at)
         VALUES (?, ?, 'spotify', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           access_token = excluded.access_token, refresh_token = excluded.refresh_token, token_expires_at = excluded.token_expires_at,
           avatar_url = excluded.avatar_url, product_tier = excluded.product_tier, updated_at = excluded.updated_at`
      ).bind(crypto.randomUUID(), uid, profile.id, encryptedAccess, encryptedRefresh, expiresAt, avatarUrl, product, now, now);

    if (existingIdentity) {
      userId = existingIdentity.user_id;
      onboarded = existingIdentity.onboarded_at != null;

      await env.DB.batch([
        env.DB.prepare('UPDATE users SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(now, userId),
        tokenStatement(userId),
      ]);
    } else {
      userId = crypto.randomUUID();
      onboarded = false;

      // spotify_id is still a required, still-UNIQUE column on users (see
      // Task 1's migration note -- it's a platform constraint, not an
      // oversight, that it can't be dropped). Keep writing the real value
      // here for constraint satisfaction; auth_identities is what the
      // application actually reads going forward.
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO users (id, spotify_id, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(userId, profile.id, profile.email ?? null, now, now),
        env.DB.prepare(
          `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
           VALUES (?, ?, 'spotify', ?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), userId, profile.id, profile.email ?? null, now, now),
        tokenStatement(userId),
      ]);
    }

    const { cookie } = await createSession(env.DB, userId, requestIsSecure(request));

    return new Response(null, {
      status: 302,
      headers: {
        Location: onboarded ? '/' : '/onboarding',
        'Set-Cookie': cookie,
      },
    });
  });

  router.post('/logout', async (request: Request, env: Env) => {
    const sessionId = parseCookie(request, 'wl_session');
    if (sessionId) {
      await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
    }
    const secure = requestIsSecure(request);
    return new Response('ok', {
      status: 200,
      headers: {
        'Set-Cookie': `wl_session=; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=0`,
      },
    });
  });
}
