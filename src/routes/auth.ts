import type { IRequest, RouterType } from 'itty-router';
import { FOLLOW_SYNC_SCOPE, PLAYLIST_SYNC_SCOPE, buildAuthUrl, exchangeCodeForToken, fetchSpotifyProfile } from '../lib/spotify';
import { hasPlaylistScope, setSyncEnabled } from '../lib/playlistSync';
import { hasFollowScope, setFollowSyncEnabled } from '../lib/followSync';
import { encrypt } from '../lib/crypto';
import { createSession, requestIsSecure, requestProtocol, getSessionUser } from '../lib/session';
import { buildGoogleAuthUrl, exchangeGoogleCode, fetchGoogleProfile } from '../lib/google';
import { isInviteOnly, claimInviteCode } from '../lib/inviteCodes';

// Always cleared alongside a resolved outcome -- a code redemption is a
// one-shot thing, never meant to outlive the signup attempt it was set for.
const CLEAR_INVITE_COOKIE = 'wl_invite_code=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

function inviteRejectResponse(): Response {
  const headers = new Headers({ Location: '/join?error=invalid_code' });
  headers.append('Set-Cookie', CLEAR_INVITE_COOKIE);
  return new Response(null, { status: 302, headers });
}

/**
 * Step 1 of the gate, called BEFORE the new user row exists -- just reads
 * the cookie, no DB write yet. `claimInviteCode`'s UPDATE stamps
 * `redeemed_by_user_id`, a NOT NULL-checked-at-write FK to users(id); doing
 * that before the user row exists would fail outright, not just logically
 * reject. `null` means "nothing to claim later" (gate off entirely) --
 * distinct from `{ reject }`, which means stop now, before creating anyone.
 */
function precheckInvite(request: Request, env: Env): { code: string } | { reject: Response } | null {
  if (!isInviteOnly(env)) return null;
  const code = parseCookie(request, 'wl_invite_code');
  return code ? { code } : { reject: inviteRejectResponse() };
}

/**
 * Step 2, called immediately AFTER the new user row has been inserted --
 * `userId` now exists, so the atomic claim's FK is satisfiable. If the code
 * turned out to be unknown, or someone else's request won the race on it in
 * the meantime, the just-created account is rolled back (auth_identities +
 * music_source_tokens, if any + users) so a rejected signup never leaves an
 * orphaned row behind -- same "closes the race" guarantee as if the check
 * had happened before creation, just sequenced around the FK constraint
 * instead of before it.
 */
async function claimInviteOrRollback(
  env: Env,
  invite: { code: string },
  userId: string,
  hadMusicSourceToken: boolean
): Promise<Response | null> {
  const now = Date.now();
  const claim = await claimInviteCode(env.DB, invite.code, userId, now);
  if (!claim.claimed) {
    const statements = [
      env.DB.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(userId),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
    ];
    if (hadMusicSourceToken) statements.splice(1, 0, env.DB.prepare('DELETE FROM music_source_tokens WHERE user_id = ?').bind(userId));
    await env.DB.batch(statements);
    return inviteRejectResponse();
  }
  await env.DB.prepare('UPDATE users SET invited_by_code_id = ?, updated_at = ? WHERE id = ?').bind(claim.codeId, now, userId).run();
  return null;
}

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
    const intent = url.searchParams.get('intent');

    // ?intent=sync is the playlist-sync upgrade trip: same OAuth flow, but
    // additionally requesting PLAYLIST_SYNC_SCOPE, which sign-in deliberately
    // never asks for (see its comment in spotify.ts). A second consent round
    // trip is unavoidable here -- a refresh cannot gain a scope the original
    // consent didn't include -- so this exists to make that trip a deliberate,
    // explained one rather than a mystery re-login.
    // Each write destination asks for its own scope and nothing more --
    // ?intent=sync never smuggles in follow access, and vice versa. Consent
    // to one must not imply the other, which is the whole reason they are
    // separate toggles.
    const extraScopes =
      intent === 'sync' ? [PLAYLIST_SYNC_SCOPE] : intent === 'follow' ? [FOLLOW_SYNC_SCOPE] : [];

    // requestProtocol, not url.protocol: see the comment on requestIsSecure
    // in session.ts -- a Cloudflare Tunnel to a local instance reports http
    // here even when the public/browser side is https, and Spotify rejects
    // a non-loopback http redirect_uri outright.
    const authUrl = buildAuthUrl(state, env, callbackUrlForHost(requestProtocol(request), url.host), extraScopes);
    const secure = requestIsSecure(request);

    // ?intent=connect (from Settings' "Connect Spotify" action) marks this as
    // linking to the currently logged-in user rather than a fresh login --
    // /callback reads this cookie to decide which path to take. ?intent=sync
    // takes that same linking path (it's always an already-logged-in user
    // upgrading their own grant) and additionally lands back on the
    // connections page with the sync result.
    const headers = new Headers({ Location: authUrl });
    headers.append('Set-Cookie', `wl_oauth_state=${state}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=600`);
    if (intent === 'connect' || intent === 'sync' || intent === 'follow') {
      headers.append('Set-Cookie', `wl_oauth_intent=${intent}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=600`);
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

  router.get('/callback/google', async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieState = parseCookie(request, 'wl_oauth_state');

    if (!code || !state || !cookieState || state !== cookieState) {
      return new Response('Invalid OAuth state', { status: 400 });
    }

    const token = await exchangeGoogleCode(code, env);
    const profile = await fetchGoogleProfile(token.access_token);
    const now = Date.now();

    // Same deliberately-unfiltered-by-deleted_at reactivation reasoning as
    // the Spotify callback's identity lookup.
    const existingIdentity = await env.DB.prepare(
      `SELECT ai.user_id, u.onboarded_at FROM auth_identities ai
       JOIN users u ON u.id = ai.user_id
       WHERE ai.provider = 'google' AND ai.provider_id = ?`
    )
      .bind(profile.sub)
      .first<{ user_id: string; onboarded_at: number | null }>();

    let userId: string;
    let onboarded: boolean;

    if (existingIdentity) {
      userId = existingIdentity.user_id;
      onboarded = existingIdentity.onboarded_at != null;
      await env.DB.prepare('UPDATE users SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(now, userId).run();
    } else {
      // Only trust the email if Google itself vouches for it -- unlike
      // Spotify (no verification flag exposed at all), Google's userinfo
      // response says explicitly whether the email is verified.
      const existingByEmail = profile.email_verified && profile.email
        ? await env.DB.prepare(`SELECT id, onboarded_at, deleted_at FROM users WHERE email = ?`)
            .bind(profile.email)
            .first<{ id: string; onboarded_at: number | null; deleted_at: number | null }>()
        : null;

      if (existingByEmail) {
        userId = existingByEmail.id;
        onboarded = existingByEmail.onboarded_at != null;

        const statements = [
          env.DB.prepare(
            `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
             VALUES (?, ?, 'google', ?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), userId, profile.sub, profile.email ?? null, now, now),
        ];
        if (existingByEmail.deleted_at != null) {
          statements.unshift(env.DB.prepare('UPDATE users SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(now, userId));
        }
        await env.DB.batch(statements);
      } else {
        userId = crypto.randomUUID();
        onboarded = false;

        // Existing users signing back in (both branches above) are never
        // gated -- this only governs first-time signup. Cookie is read
        // BEFORE the user exists (see precheckInvite's own comment on why);
        // the real atomic claim happens right after creation, below.
        const invite = precheckInvite(request, env);
        if (invite && 'reject' in invite) return invite.reject;

        // A Google-only user has no real Spotify id -- spotify_id is still
        // UNIQUE NOT NULL, so this user's own id (guaranteed unique, already
        // generated) is written as a harmless placeholder. auth_identities is
        // what the application actually reads; this column is never read for
        // a Google-signed-in user.
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO users (id, spotify_id, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
            .bind(userId, userId, profile.email ?? null, now, now),
          env.DB.prepare(
            `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
             VALUES (?, ?, 'google', ?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), userId, profile.sub, profile.email ?? null, now, now),
        ]);

        if (invite) {
          const rejection = await claimInviteOrRollback(env, invite, userId, false);
          if (rejection) return rejection;
        }
      }
    }

    const { cookie } = await createSession(env.DB, userId, requestIsSecure(request));

    const headers = new Headers({ Location: onboarded ? '/' : '/onboarding' });
    headers.append('Set-Cookie', cookie);
    // Harmless when it was never set (an existing user signing back in, or
    // INVITE_ONLY off) -- clearing an absent cookie is a no-op.
    headers.append('Set-Cookie', CLEAR_INVITE_COOKIE);
    return new Response(null, { status: 302, headers });
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
    const grantedScope = token.scope ?? null;

    const tokenStatement = (uid: string) =>
      env.DB.prepare(
        `INSERT INTO music_source_tokens (id, user_id, provider, provider_user_id, access_token, refresh_token, token_expires_at, avatar_url, product_tier, granted_scope, created_at, updated_at)
         VALUES (?, ?, 'spotify', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           access_token = excluded.access_token, refresh_token = excluded.refresh_token, token_expires_at = excluded.token_expires_at,
           avatar_url = excluded.avatar_url, product_tier = excluded.product_tier, granted_scope = excluded.granted_scope, updated_at = excluded.updated_at`
      ).bind(crypto.randomUUID(), uid, profile.id, encryptedAccess, encryptedRefresh, expiresAt, avatarUrl, product, grantedScope, now, now);

    // ?intent=connect (set by /login/spotify) means "link this Spotify
    // account to my current session's user," not a fresh login/signup.
    const intentCookie = parseCookie(request, 'wl_oauth_intent');
    const clearIntentCookie = 'wl_oauth_intent=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

    if (intentCookie === 'connect' || intentCookie === 'sync' || intentCookie === 'follow') {
      const currentUser = await getSessionUser(request, env.DB);
      if (currentUser) {
        const claimedBy = await env.DB.prepare(
          `SELECT user_id FROM auth_identities WHERE provider = 'spotify' AND provider_id = ?`
        ).bind(profile.id).first<{ user_id: string }>();

        if (claimedBy && claimedBy.user_id !== currentUser.id) {
          const headers = new Headers({ Location: '/settings/connections?spotify_error=already_linked' });
          headers.append('Set-Cookie', clearIntentCookie);
          return new Response(null, { status: 302, headers });
        }

        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
             VALUES (?, ?, 'spotify', ?, ?, ?, ?)
             ON CONFLICT(provider, provider_id) DO NOTHING`
          ).bind(crypto.randomUUID(), currentUser.id, profile.id, profile.email ?? null, now, now),
          tokenStatement(currentUser.id),
        ]);

        if (intentCookie === 'follow') {
          // Same rule as playlist sync: only flip the flag if Spotify
          // actually granted the scope, since the consent screen has its own
          // cancel/partial paths and a toggle claiming a grant that didn't
          // happen would be a lie the token can't back.
          const granted = hasFollowScope(grantedScope);
          if (granted) await setFollowSyncEnabled(env.DB, currentUser.id, true, now);

          const headers = new Headers({
            Location: granted ? '/settings/connections?follow_enabled=1' : '/settings/connections?follow_error=denied',
          });
          headers.append('Set-Cookie', clearIntentCookie);
          return new Response(null, { status: 302, headers });
        }

        if (intentCookie === 'sync') {
          // Only flip sync on if Spotify actually granted the write scope --
          // the consent screen has its own "Cancel"/partial-grant paths, and
          // enabling sync against a grant that didn't happen would leave the
          // UI claiming a state the token can't back. grantedScope is what
          // Spotify returned for this exact exchange, so this is the
          // authoritative answer, not an assumption.
          const granted = hasPlaylistScope(grantedScope);
          if (granted) await setSyncEnabled(env.DB, currentUser.id, true, now);

          const headers = new Headers({
            Location: granted ? '/settings/connections?sync_enabled=1' : '/settings/connections?sync_error=denied',
          });
          headers.append('Set-Cookie', clearIntentCookie);
          return new Response(null, { status: 302, headers });
        }

        const headers = new Headers({ Location: '/settings/connections?spotify_connected=1' });
        headers.append('Set-Cookie', clearIntentCookie);
        return new Response(null, { status: 302, headers });
      }
      // No active session (it expired mid-flow) -- fall through to normal
      // login/signup below, same as if intent had never been set.
    }

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

    if (existingIdentity) {
      userId = existingIdentity.user_id;
      onboarded = existingIdentity.onboarded_at != null;

      await env.DB.batch([
        env.DB.prepare('UPDATE users SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(now, userId),
        tokenStatement(userId),
      ]);
    } else {
      // No Spotify identity yet -- check whether this email already belongs
      // to a user via a different provider (e.g. they signed up with Google
      // first) before creating a duplicate account. Not filtered by
      // deleted_at, same reactivation reasoning as the same-provider lookup
      // above.
      const existingByEmail = profile.email
        ? await env.DB.prepare(`SELECT id, onboarded_at, deleted_at FROM users WHERE email = ?`)
            .bind(profile.email)
            .first<{ id: string; onboarded_at: number | null; deleted_at: number | null }>()
        : null;

      if (existingByEmail) {
        userId = existingByEmail.id;
        onboarded = existingByEmail.onboarded_at != null;

        const statements = [
          env.DB.prepare(
            `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
             VALUES (?, ?, 'spotify', ?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), userId, profile.id, profile.email ?? null, now, now),
          tokenStatement(userId),
        ];
        if (existingByEmail.deleted_at != null) {
          statements.unshift(env.DB.prepare('UPDATE users SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(now, userId));
        }
        await env.DB.batch(statements);
      } else {
        userId = crypto.randomUUID();
        onboarded = false;

        // Existing users signing back in (both branches above, plus the
        // ?intent=connect/sync/follow account-linking branch far above,
        // which returns before ever reaching here) are never gated -- this
        // only governs first-time signup. Cookie is read BEFORE the user
        // exists (see precheckInvite's own comment on why); the real atomic
        // claim happens right after creation, below.
        const invite = precheckInvite(request, env);
        if (invite && 'reject' in invite) return invite.reject;

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

        if (invite) {
          const rejection = await claimInviteOrRollback(env, invite, userId, true);
          if (rejection) return rejection;
        }
      }
    }

    const { cookie } = await createSession(env.DB, userId, requestIsSecure(request));

    const headers = new Headers({ Location: onboarded ? '/' : '/onboarding' });
    headers.append('Set-Cookie', cookie);
    if (intentCookie) headers.append('Set-Cookie', clearIntentCookie);
    // Harmless when it was never set (an existing user signing back in, or
    // INVITE_ONLY off) -- clearing an absent cookie is a no-op.
    headers.append('Set-Cookie', CLEAR_INVITE_COOKIE);
    return new Response(null, { status: 302, headers });
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
