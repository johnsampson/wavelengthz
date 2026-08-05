import type { IRequest, RouterType } from 'itty-router';
import { buildAuthUrl, exchangeCodeForToken, fetchSpotifyProfile } from '../lib/spotify';
import { encrypt } from '../lib/crypto';
import { createSession, requestIsSecure } from '../lib/session';

function parseCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export function registerAuthRoutes(router: RouterType) {
  router.get('/login', async (request: IRequest, env: Env) => {
    const state = crypto.randomUUID();
    const authUrl = buildAuthUrl(state, env);
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

    const token = await exchangeCodeForToken(code, env);
    const profile = await fetchSpotifyProfile(token.access_token);

    const encryptedAccess = await encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY);
    const encryptedRefresh = await encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY);
    const now = Date.now();
    const expiresAt = now + token.expires_in * 1000;

    // Deliberately not filtered by deleted_at IS NULL: spotify_id is UNIQUE, so a
    // soft-deleted row permanently occupies that Spotify account's slot. Signing
    // back in during the grace period (before the nightly hard-delete purge)
    // reactivates the account below rather than leaving it stuck -- found with
    // deleted_at still set, but with no way to ever pass getSessionUser's
    // deleted_at IS NULL check, and no way to re-register the same Spotify
    // account as "new" either.
    const existing = await env.DB.prepare('SELECT id, onboarded_at, deleted_at FROM users WHERE spotify_id = ?')
      .bind(profile.id)
      .first<{ id: string; onboarded_at: number | null; deleted_at: number | null }>();

    const userId = existing?.id ?? crypto.randomUUID();
    // A brand-new insert always has onboarded_at NULL (not set on insert), so this
    // single check naturally covers both the new-user and abandoned-onboarding cases.
    const onboarded = existing?.onboarded_at != null;
    const avatarUrl = profile.images?.[0]?.url ?? null;
    const product = profile.product ?? null;

    if (existing) {
      await env.DB.prepare(
        `UPDATE users SET access_token = ?, refresh_token = ?, token_expires_at = ?, spotify_avatar_url = ?, spotify_product = ?, deleted_at = NULL, updated_at = ?
         WHERE id = ?`
      ).bind(encryptedAccess, encryptedRefresh, expiresAt, avatarUrl, product, now, userId).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO users (id, spotify_id, email, spotify_avatar_url, spotify_product, access_token, refresh_token, token_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(userId, profile.id, profile.email ?? null, avatarUrl, product, encryptedAccess, encryptedRefresh, expiresAt, now, now).run();
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
