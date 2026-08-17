import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';
import { insertTestUser } from '../helpers/createUser';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
});

describe('GET /login/spotify', () => {
  it('redirects to Spotify authorize with a state cookie set', async () => {
    const req = new Request('http://127.0.0.1:8787/login/spotify');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('https://accounts.spotify.com/authorize');
    const setCookie = res.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('wl_oauth_state=');
  });

  it('requests the playlist write scope only for ?intent=sync', async () => {
    const plain = await worker.fetch(new Request('http://127.0.0.1:8787/login/spotify'), env, {} as ExecutionContext);
    const plainScope = new URL(plain.headers.get('Location')!).searchParams.get('scope')!;
    expect(plainScope).not.toContain('playlist-modify-private');

    const sync = await worker.fetch(new Request('http://127.0.0.1:8787/login/spotify?intent=sync'), env, {} as ExecutionContext);
    const syncScope = new URL(sync.headers.get('Location')!).searchParams.get('scope')!;
    expect(syncScope).toContain('playlist-modify-private');
    // Additive: the upgrade trip must not drop what the account already has.
    expect(syncScope).toContain('streaming');
  });

  it('marks the sync upgrade trip with its own intent cookie', async () => {
    const res = await worker.fetch(new Request('http://127.0.0.1:8787/login/spotify?intent=sync'), env, {} as ExecutionContext);
    const cookies = res.headers.getAll('Set-Cookie').join('; ');
    expect(cookies).toContain('wl_oauth_intent=sync');
  });

  it('omits Secure on the state cookie over plain http', async () => {
    // Safari refuses to store a Secure cookie over http, even for
    // 127.0.0.1 -- unlike Chromium, which special-cases localhost. Local dev
    // (wrangler over http://127.0.0.1) needs Secure dropped or Safari's
    // /callback never sees the state cookie back, producing "Invalid OAuth
    // state" with nothing wrong server-side.
    const req = new Request('http://127.0.0.1:8787/login/spotify');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const setCookie = res.headers.get('Set-Cookie')!;
    expect(setCookie).not.toContain('Secure');
  });

  it('keeps Secure on the state cookie over https', async () => {
    // Same host as SPOTIFY_REDIRECT_URI (127.0.0.1:8787) -- only the
    // protocol differs -- so this isolates the Secure-flag behavior from
    // the host-canonicalization redirect covered below.
    const req = new Request('https://127.0.0.1:8787/login/spotify');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const setCookie = res.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('Secure');
  });

  it('redirects to the canonical SPOTIFY_REDIRECT_URI host instead of setting the state cookie, when reached via a different host', async () => {
    // The state cookie is host-scoped. If /login/spotify is reached via a
    // host that doesn't match SPOTIFY_REDIRECT_URI's host (e.g. "localhost",
    // which is exactly what `wrangler dev` itself prints as "Ready on
    // http://localhost:8787" every time it (re)starts, while
    // SPOTIFY_REDIRECT_URI is configured as 127.0.0.1), a cookie set here
    // would never be sent back when Spotify redirects to /callback on the
    // *other* host -- producing "Invalid OAuth state" every single time,
    // with nothing actually wrong server-side. Funnel onto the canonical
    // host first, before ever setting the cookie.
    const req = new Request('http://localhost:8787/login/spotify');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('http://127.0.0.1:8787/login/spotify');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('preserves the query string when redirecting to the canonical host', async () => {
    const req = new Request('http://localhost:8787/login/spotify?foo=bar');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.headers.get('Location')).toBe('http://127.0.0.1:8787/login/spotify?foo=bar');
  });

  it('serves OAuth directly (no redirect) on a host listed in SPOTIFY_ALLOWED_HOSTS, using that host as the redirect_uri', async () => {
    // env.test.vars sets SPOTIFY_ALLOWED_HOSTS=allowed.example.com -- e.g. a
    // Cloudflare Tunnel hostname someone's opted into for testing on a real
    // phone, distinct from the SPOTIFY_REDIRECT_URI default.
    const req = new Request('https://allowed.example.com/login/spotify');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('https://accounts.spotify.com/authorize');
    expect(location).toContain(encodeURIComponent('https://allowed.example.com/callback'));
    expect(res.headers.get('Set-Cookie')).toContain('wl_oauth_state=');
  });

  it('builds an https redirect_uri for an allowlisted host even though the request URL itself is http -- the Cloudflare Tunnel case', async () => {
    // cloudflared terminates TLS at Cloudflare's edge but proxies to this
    // local Worker over plain http without forwarding X-Forwarded-Proto (a
    // documented gap: github.com/cloudflare/cloudflared/issues/1245), so
    // request.url looks like http even though the public/browser side is
    // genuinely https. Spotify requires https for any non-loopback redirect
    // URI, so getting this wrong makes the tunnel host completely unusable,
    // not just insecure.
    const req = new Request('http://allowed.example.com/login/spotify', {
      headers: { 'CF-Visitor': '{"scheme":"https"}' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain(encodeURIComponent('https://allowed.example.com/callback'));
    expect(res.headers.get('Set-Cookie')).toContain('Secure');
  });

  it('still redirects to the canonical host when reached via a host that is neither SPOTIFY_REDIRECT_URI nor in SPOTIFY_ALLOWED_HOSTS', async () => {
    const req = new Request('https://not-allowed.example.com/login/spotify');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('http://127.0.0.1:8787/login/spotify');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('sets an additional wl_oauth_intent=connect cookie when reached with ?intent=connect', async () => {
    const req = new Request('http://127.0.0.1:8787/login/spotify?intent=connect');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.includes('wl_oauth_state='))).toBe(true);
    expect(setCookies.some((c) => c.includes('wl_oauth_intent=connect'))).toBe(true);
  });

  it('does not set wl_oauth_intent when reached without ?intent=connect', async () => {
    const req = new Request('http://127.0.0.1:8787/login/spotify');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.includes('wl_oauth_intent'))).toBe(false);
  });
});

describe('GET /login/google', () => {
  it('redirects to Google authorize with a state cookie set', async () => {
    const req = new Request('http://127.0.0.1:8787/login/google');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(res.headers.get('Set-Cookie')).toContain('wl_oauth_state=');
  });

  it('omits Secure on the state cookie over plain http, keeps it over https', async () => {
    const httpReq = new Request('http://127.0.0.1:8787/login/google');
    const httpRes = await worker.fetch(httpReq, env, {} as ExecutionContext);
    expect(httpRes.headers.get('Set-Cookie')).not.toContain('Secure');

    const httpsReq = new Request('https://wavelengthz.app/login/google');
    const httpsRes = await worker.fetch(httpsReq, env, {} as ExecutionContext);
    expect(httpsRes.headers.get('Set-Cookie')).toContain('Secure');
  });
});

describe('GET /callback', () => {
  it('rejects a callback whose state does not match the cookie', async () => {
    const req = new Request('http://localhost/callback?code=abc&state=wrong', {
      headers: { Cookie: 'wl_oauth_state=right' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it('sends a redirect_uri matching the allowlisted host to the token exchange, not the SPOTIFY_REDIRECT_URI default', async () => {
    // Spotify requires the token exchange's redirect_uri to exactly match
    // whatever /login sent to /authorize -- which, for a request landing on
    // an allowlisted host, is that host's own callback URL (see
    // callbackUrlForHost in src/routes/auth.ts), not the configured default.
    let tokenExchangeBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          tokenExchangeBody = String(init?.body ?? '');
          return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(JSON.stringify({ id: 'spotify-allowed-host-user' }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('https://allowed.example.com/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(new URLSearchParams(tokenExchangeBody).get('redirect_uri')).toBe('https://allowed.example.com/callback');

    vi.unstubAllGlobals();
  });

  it('creates a user, identity, and token row on a valid callback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(
            JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
            { status: 200 }
          );
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(
            JSON.stringify({
              id: 'spotify-xyz',
              email: 'user@example.com',
              images: [{ url: 'https://img.example/avatar.jpg' }],
              product: 'premium',
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Set-Cookie')).toContain('wl_session=');

    const identity = await env.DB.prepare(`SELECT * FROM auth_identities WHERE provider = 'spotify' AND provider_id = ?`)
      .bind('spotify-xyz')
      .first<any>();
    expect(identity).toBeTruthy();
    expect(identity.email).toBe('user@example.com');

    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(identity.user_id).first<any>();
    expect(user.email).toBe('user@example.com');

    const tokenRow = await env.DB.prepare(`SELECT * FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`)
      .bind(identity.user_id)
      .first<any>();
    expect(tokenRow.access_token).not.toBe('at'); // encrypted, not plaintext
    expect(tokenRow.avatar_url).toBe('https://img.example/avatar.jpg');
    expect(tokenRow.product_tier).toBe('premium');

    vi.unstubAllGlobals();
  });

  it('persists the granted OAuth scope on the token row, for GET /api/me/player-token to check against', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(
            JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'user-top-read streaming user-read-playback-state' }),
            { status: 200 }
          );
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(JSON.stringify({ id: 'spotify-scoped', product: 'premium' }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    await worker.fetch(req, env, {} as ExecutionContext);

    const tokenRow = await env.DB.prepare(`SELECT granted_scope FROM music_source_tokens WHERE provider_user_id = 'spotify-scoped'`).first<any>();
    expect(tokenRow.granted_scope).toBe('user-top-read streaming user-read-playback-state');

    vi.unstubAllGlobals();
  });

  it('leaves granted_scope null rather than the string "undefined" when Spotify omits scope from the response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(JSON.stringify({ id: 'spotify-unscoped' }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    await worker.fetch(req, env, {} as ExecutionContext);

    const tokenRow = await env.DB.prepare(`SELECT granted_scope FROM music_source_tokens WHERE provider_user_id = 'spotify-unscoped'`).first<any>();
    expect(tokenRow.granted_scope).toBeNull();

    vi.unstubAllGlobals();
  });

  it('omits Secure on the session cookie over plain http, keeps it over https', async () => {
    const stubFetch = () =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.includes('accounts.spotify.com/api/token')) {
            return new Response(
              JSON.stringify({ access_token: 'at-secure-check', refresh_token: 'rt-secure-check', expires_in: 3600 }),
              { status: 200 }
            );
          }
          if (url.includes('api.spotify.com/v1/me')) {
            return new Response(JSON.stringify({ id: 'spotify-secure-check', email: 'sc@example.com' }), { status: 200 });
          }
          throw new Error(`unexpected fetch: ${url}`);
        })
      );

    stubFetch();
    const httpReq = new Request('http://127.0.0.1:8787/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const httpRes = await worker.fetch(httpReq, env, {} as ExecutionContext);
    expect(httpRes.headers.get('Set-Cookie')).not.toContain('Secure');
    vi.unstubAllGlobals();

    const { user_id: secureCheckUserId } = (await env.DB.prepare(
      `SELECT user_id FROM auth_identities WHERE provider_id = 'spotify-secure-check'`
    ).first<{ user_id: string }>())!;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(secureCheckUserId),
      env.DB.prepare('DELETE FROM music_source_tokens WHERE user_id = ?').bind(secureCheckUserId),
      env.DB.prepare(`DELETE FROM auth_identities WHERE provider_id = 'spotify-secure-check'`),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(secureCheckUserId),
    ]);

    stubFetch();
    const httpsReq = new Request('https://wavelengthz.app/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const httpsRes = await worker.fetch(httpsReq, env, {} as ExecutionContext);
    expect(httpsRes.headers.get('Set-Cookie')).toContain('Secure');
    vi.unstubAllGlobals();
  });

  it('refreshes the stored Spotify avatar URL and payment status when an existing user logs in again', async () => {
    const now = Date.now();
    const userId = await insertTestUser(env.DB, {
      spotifyId: 'spotify-avatar-user',
      email: 'user@example.com',
      avatarUrl: 'https://img.example/old-avatar.jpg',
      productTier: 'free',
      onboardedAt: now,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'at4', refresh_token: 'rt4', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(
            JSON.stringify({
              id: 'spotify-avatar-user',
              email: 'user@example.com',
              images: [{ url: 'https://img.example/new-avatar.jpg' }],
              product: 'premium',
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);

    const tokenRow = await env.DB.prepare(`SELECT avatar_url, product_tier FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`)
      .bind(userId)
      .first<any>();
    expect(tokenRow.avatar_url).toBe('https://img.example/new-avatar.jpg');
    expect(tokenRow.product_tier).toBe('premium');

    vi.unstubAllGlobals();
  });

  it('redirects an existing user whose onboarding is incomplete to /onboarding', async () => {
    await insertTestUser(env.DB, { spotifyId: 'spotify-xyz', email: 'user@example.com', onboardedAt: null });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(
            JSON.stringify({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }),
            { status: 200 }
          );
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(
            JSON.stringify({ id: 'spotify-xyz', email: 'user@example.com' }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/onboarding');

    vi.unstubAllGlobals();
  });

  it('reactivates a soft-deleted account on login instead of leaving it unauthenticatable', async () => {
    const now = Date.now();
    await insertTestUser(env.DB, { spotifyId: 'spotify-soft-deleted', email: 'user@example.com', onboardedAt: now, deletedAt: now });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'at5', refresh_token: 'rt5', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(
            JSON.stringify({ id: 'spotify-soft-deleted', email: 'user@example.com' }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');

    const identity = await env.DB.prepare(`SELECT user_id FROM auth_identities WHERE provider_id = 'spotify-soft-deleted'`).first<any>();
    const user = await env.DB.prepare('SELECT deleted_at FROM users WHERE id = ?').bind(identity.user_id).first<any>();
    expect(user.deleted_at).toBeNull();

    vi.unstubAllGlobals();
  });

  it('redirects an existing, fully-onboarded user to /', async () => {
    const now = Date.now();
    await insertTestUser(env.DB, { spotifyId: 'spotify-onboarded', email: 'user2@example.com', onboardedAt: now });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(
            JSON.stringify({ access_token: 'at3', refresh_token: 'rt3', expires_in: 3600 }),
            { status: 200 }
          );
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(
            JSON.stringify({ id: 'spotify-onboarded', email: 'user2@example.com' }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');

    vi.unstubAllGlobals();
  });

  it('links to an existing user found by email instead of creating a duplicate, when no Spotify identity exists yet', async () => {
    const existingUserId = await insertTestUser(env.DB, { email: 'shared@example.com', skipSpotify: true, onboardedAt: Date.now() });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(JSON.stringify({ id: 'spotify-linkme', email: 'shared@example.com' }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/'); // already onboarded

    const identity = await env.DB.prepare(`SELECT user_id FROM auth_identities WHERE provider_id = 'spotify-linkme'`).first<any>();
    expect(identity.user_id).toBe(existingUserId); // linked, not a new user

    const usersCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE email = 'shared@example.com'`).first<any>();
    expect(usersCount.c).toBe(1); // no duplicate

    vi.unstubAllGlobals();
  });

  it('connects Spotify to the currently logged-in user when intent=connect, without creating a new account', async () => {
    const googleUserId = await insertTestUser(env.DB, { email: 'connectme@example.com', skipSpotify: true, onboardedAt: Date.now() });
    const { id: sessionId } = await createSession(env.DB, googleUserId);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(JSON.stringify({ id: 'spotify-connect-target', email: 'different@example.com' }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: `wl_oauth_state=match; wl_oauth_intent=connect; wl_session=${sessionId}` },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/settings/connections?spotify_connected=1');

    const identity = await env.DB.prepare(`SELECT user_id FROM auth_identities WHERE provider_id = 'spotify-connect-target'`).first<any>();
    expect(identity.user_id).toBe(googleUserId);

    const tokenRow = await env.DB.prepare(`SELECT * FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`).bind(googleUserId).first<any>();
    expect(tokenRow).toBeTruthy();

    const usersCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM users`).first<any>();
    expect(usersCount.c).toBe(1); // no second user created

    vi.unstubAllGlobals();
  });

  it('rejects connecting a Spotify account that is already linked to a different user', async () => {
    const userA = await insertTestUser(env.DB, { spotifyId: 'spotify-already-claimed' });
    const userB = await insertTestUser(env.DB, { email: 'userb@example.com', skipSpotify: true, onboardedAt: Date.now() });
    const { id: sessionId } = await createSession(env.DB, userB);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(JSON.stringify({ id: 'spotify-already-claimed', email: 'usera@example.com' }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: `wl_oauth_state=match; wl_oauth_intent=connect; wl_session=${sessionId}` },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/settings/connections?spotify_error=already_linked');

    const identity = await env.DB.prepare(`SELECT user_id FROM auth_identities WHERE provider_id = 'spotify-already-claimed'`).first<any>();
    expect(identity.user_id).toBe(userA); // unchanged, still belongs to user A

    vi.unstubAllGlobals();
  });
});

describe('GET /callback/google', () => {
  it('rejects a callback whose state does not match the cookie', async () => {
    const req = new Request('http://localhost/callback/google?code=abc&state=wrong', {
      headers: { Cookie: 'wl_oauth_state=right' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it('creates a new user with a placeholder spotify_id and a google auth_identities row, no music_source_tokens row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'gtoken', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
          return new Response(JSON.stringify({ sub: 'google-xyz', email: 'guser@example.com', email_verified: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback/google?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/onboarding');
    expect(res.headers.get('Set-Cookie')).toContain('wl_session=');

    const identity = await env.DB.prepare(`SELECT * FROM auth_identities WHERE provider = 'google' AND provider_id = 'google-xyz'`).first<any>();
    expect(identity).toBeTruthy();
    expect(identity.email).toBe('guser@example.com');

    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(identity.user_id).first<any>();
    expect(user.spotify_id).toBe(identity.user_id); // placeholder = own id
    expect(user.email).toBe('guser@example.com');

    const tokenRow = await env.DB.prepare(`SELECT * FROM music_source_tokens WHERE user_id = ?`).bind(identity.user_id).first();
    expect(tokenRow).toBeNull();

    vi.unstubAllGlobals();
  });

  it('links to an existing Spotify-created user by email when Google reports it verified', async () => {
    const existingUserId = await insertTestUser(env.DB, { email: 'shared2@example.com', onboardedAt: Date.now() });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'gtoken', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
          return new Response(JSON.stringify({ sub: 'google-linkme', email: 'shared2@example.com', email_verified: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback/google?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/'); // already onboarded

    const identity = await env.DB.prepare(`SELECT user_id FROM auth_identities WHERE provider_id = 'google-linkme'`).first<any>();
    expect(identity.user_id).toBe(existingUserId);

    vi.unstubAllGlobals();
  });

  it('does not auto-link by email when Google reports it unverified', async () => {
    await insertTestUser(env.DB, { email: 'unverified@example.com', onboardedAt: Date.now() });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'gtoken', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
          return new Response(JSON.stringify({ sub: 'google-unverified', email: 'unverified@example.com', email_verified: false }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback/google?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/onboarding'); // treated as a brand-new user

    const usersCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE email = 'unverified@example.com'`).first<any>();
    expect(usersCount.c).toBe(2); // did NOT link -- a second, separate user was created

    vi.unstubAllGlobals();
  });

  it('reactivates a soft-deleted account found by identity', async () => {
    const now = Date.now();
    const userId = await insertTestUser(env.DB, { skipSpotify: true, onboardedAt: now, deletedAt: now, email: 'gsoftdel@example.com' });
    await env.DB.prepare(
      `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at) VALUES (?, ?, 'google', 'google-soft-deleted', ?, ?, ?)`
    ).bind(crypto.randomUUID(), userId, 'gsoftdel@example.com', now, now).run();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'gtoken', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
          return new Response(JSON.stringify({ sub: 'google-soft-deleted', email: 'gsoftdel@example.com', email_verified: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback/google?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');

    const user = await env.DB.prepare('SELECT deleted_at FROM users WHERE id = ?').bind(userId).first<any>();
    expect(user.deleted_at).toBeNull();

    vi.unstubAllGlobals();
  });
});

describe('POST /logout', () => {
  it('clears the session cookie', async () => {
    const req = new Request('http://localhost/logout', { method: 'POST' });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('wl_session=;');
  });

  it('still clears the cookie when there is no session cookie present', async () => {
    const req = new Request('http://localhost/logout', { method: 'POST' });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('wl_session=;');
  });

  it('omits Secure on the clear-cookie over plain http, keeps it over https', async () => {
    const httpReq = new Request('http://127.0.0.1:8787/logout', { method: 'POST' });
    const httpRes = await worker.fetch(httpReq, env, {} as ExecutionContext);
    expect(httpRes.headers.get('Set-Cookie')).not.toContain('Secure');

    const httpsReq = new Request('https://wavelengthz.app/logout', { method: 'POST' });
    const httpsRes = await worker.fetch(httpsReq, env, {} as ExecutionContext);
    expect(httpsRes.headers.get('Set-Cookie')).toContain('Secure');
  });

  it('deletes the session row from the database so the cookie cannot be replayed', async () => {
    await insertTestUser(env.DB, { id: 'user-logout-test', spotifyId: 'spotify-logout-test' });

    const { id: sessionId } = await createSession(env.DB, 'user-logout-test');

    const before = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?')
      .bind(sessionId)
      .first<any>();
    expect(before).toBeTruthy();

    const req = new Request('http://localhost/logout', {
      method: 'POST',
      headers: { Cookie: `wl_session=${sessionId}` },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);

    const after = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?')
      .bind(sessionId)
      .first<any>();
    expect(after).toBeNull();
  });
});
