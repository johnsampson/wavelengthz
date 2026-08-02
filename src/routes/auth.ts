import type { IRequest, RouterType } from 'itty-router';
import { buildAuthUrl, exchangeCodeForToken, fetchSpotifyProfile } from '../lib/spotify';
import { encrypt } from '../lib/crypto';
import { createSession } from '../lib/session';

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
    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl,
        'Set-Cookie': `wl_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
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

    const existing = await env.DB.prepare('SELECT id, onboarded_at FROM users WHERE spotify_id = ?')
      .bind(profile.id)
      .first<{ id: string; onboarded_at: number | null }>();

    const userId = existing?.id ?? crypto.randomUUID();
    // A brand-new insert always has onboarded_at NULL (not set on insert), so this
    // single check naturally covers both the new-user and abandoned-onboarding cases.
    const onboarded = existing?.onboarded_at != null;

    if (existing) {
      await env.DB.prepare(
        `UPDATE users SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(encryptedAccess, encryptedRefresh, expiresAt, now, userId).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO users (id, spotify_id, email, access_token, refresh_token, token_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(userId, profile.id, profile.email ?? null, encryptedAccess, encryptedRefresh, expiresAt, now, now).run();
    }

    const { cookie } = await createSession(env.DB, userId);

    return new Response(null, {
      status: 302,
      headers: {
        Location: onboarded ? '/' : '/onboarding.html',
        'Set-Cookie': cookie,
      },
    });
  });

  router.post('/logout', async (request: Request, env: Env) => {
    const sessionId = parseCookie(request, 'wl_session');
    if (sessionId) {
      await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
    }
    return new Response('ok', {
      status: 200,
      headers: {
        'Set-Cookie': 'wl_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      },
    });
  });
}
