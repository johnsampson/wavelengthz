import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM users;');
});

describe('GET /login', () => {
  it('redirects to Spotify authorize with a state cookie set', async () => {
    const req = new Request('http://127.0.0.1:8787/login');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('https://accounts.spotify.com/authorize');
    const setCookie = res.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('wl_oauth_state=');
  });

  it('omits Secure on the state cookie over plain http', async () => {
    // Safari refuses to store a Secure cookie over http, even for
    // 127.0.0.1 -- unlike Chromium, which special-cases localhost. Local dev
    // (wrangler over http://127.0.0.1) needs Secure dropped or Safari's
    // /callback never sees the state cookie back, producing "Invalid OAuth
    // state" with nothing wrong server-side.
    const req = new Request('http://127.0.0.1:8787/login');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const setCookie = res.headers.get('Set-Cookie')!;
    expect(setCookie).not.toContain('Secure');
  });

  it('keeps Secure on the state cookie over https', async () => {
    // Same host as SPOTIFY_REDIRECT_URI (127.0.0.1:8787) -- only the
    // protocol differs -- so this isolates the Secure-flag behavior from
    // the host-canonicalization redirect covered below.
    const req = new Request('https://127.0.0.1:8787/login');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const setCookie = res.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('Secure');
  });

  it('redirects to the canonical SPOTIFY_REDIRECT_URI host instead of setting the state cookie, when reached via a different host', async () => {
    // The state cookie is host-scoped. If /login is reached via a host that
    // doesn't match SPOTIFY_REDIRECT_URI's host (e.g. "localhost", which is
    // exactly what `wrangler dev` itself prints as "Ready on
    // http://localhost:8787" every time it (re)starts, while
    // SPOTIFY_REDIRECT_URI is configured as 127.0.0.1), a cookie set here
    // would never be sent back when Spotify redirects to /callback on the
    // *other* host -- producing "Invalid OAuth state" every single time,
    // with nothing actually wrong server-side. Funnel onto the canonical
    // host first, before ever setting the cookie.
    const req = new Request('http://localhost:8787/login');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('http://127.0.0.1:8787/login');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('preserves the query string when redirecting to the canonical host', async () => {
    const req = new Request('http://localhost:8787/login?foo=bar');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.headers.get('Location')).toBe('http://127.0.0.1:8787/login?foo=bar');
  });

  it('serves OAuth directly (no redirect) on a host listed in SPOTIFY_ALLOWED_HOSTS, using that host as the redirect_uri', async () => {
    // env.test.vars sets SPOTIFY_ALLOWED_HOSTS=allowed.example.com -- e.g. a
    // Cloudflare Tunnel hostname someone's opted into for testing on a real
    // phone, distinct from the SPOTIFY_REDIRECT_URI default.
    const req = new Request('https://allowed.example.com/login');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('https://accounts.spotify.com/authorize');
    expect(location).toContain(encodeURIComponent('https://allowed.example.com/callback'));
    expect(res.headers.get('Set-Cookie')).toContain('wl_oauth_state=');
  });

  it('still redirects to the canonical host when reached via a host that is neither SPOTIFY_REDIRECT_URI nor in SPOTIFY_ALLOWED_HOSTS', async () => {
    const req = new Request('https://not-allowed.example.com/login');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('http://127.0.0.1:8787/login');
    expect(res.headers.get('Set-Cookie')).toBeNull();
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

  it('creates a user and session on a valid callback', async () => {
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

    const row = await env.DB.prepare('SELECT * FROM users WHERE spotify_id = ?')
      .bind('spotify-xyz')
      .first<any>();
    expect(row).toBeTruthy();
    expect(row.email).toBe('user@example.com');
    expect(row.access_token).not.toBe('at'); // encrypted, not plaintext
    expect(row.spotify_avatar_url).toBe('https://img.example/avatar.jpg');
    expect(row.spotify_product).toBe('premium');

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

    await env.DB.exec(
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE spotify_id = 'spotify-secure-check'); DELETE FROM users WHERE spotify_id = 'spotify-secure-check';`
    );

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
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, email, spotify_avatar_url, spotify_product, access_token, refresh_token, token_expires_at, onboarded_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        'user-existing-avatar',
        'spotify-avatar-user',
        'user@example.com',
        'https://img.example/old-avatar.jpg',
        'free',
        'old-at',
        'old-rt',
        now + 3600 * 1000,
        now,
        now,
        now
      )
      .run();

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

    const row = await env.DB.prepare('SELECT spotify_avatar_url, spotify_product FROM users WHERE spotify_id = ?')
      .bind('spotify-avatar-user')
      .first<any>();
    expect(row.spotify_avatar_url).toBe('https://img.example/new-avatar.jpg');
    expect(row.spotify_product).toBe('premium');

    vi.unstubAllGlobals();
  });

  it('redirects an existing user whose onboarding is incomplete to /onboarding', async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, email, access_token, refresh_token, token_expires_at, onboarded_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        'user-existing-unonboarded',
        'spotify-xyz',
        'user@example.com',
        'old-at',
        'old-rt',
        now + 3600 * 1000,
        null,
        now,
        now
      )
      .run();

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
    // getSessionUser() requires deleted_at IS NULL, and spotify_id is UNIQUE, so
    // if login doesn't clear deleted_at here, the account is a permanent dead
    // end: signing in "succeeds" with a 302 + session cookie, but every
    // subsequent request 401s, and a fresh signup with the same Spotify account
    // is impossible because the row already exists.
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, email, access_token, refresh_token, token_expires_at, onboarded_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        'user-soft-deleted',
        'spotify-soft-deleted',
        'user@example.com',
        'old-at',
        'old-rt',
        now + 3600 * 1000,
        now,
        now,
        now,
        now
      )
      .run();

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

    const row = await env.DB.prepare('SELECT deleted_at FROM users WHERE spotify_id = ?')
      .bind('spotify-soft-deleted')
      .first<any>();
    expect(row.deleted_at).toBeNull();

    vi.unstubAllGlobals();
  });

  it('redirects an existing, fully-onboarded user to /', async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, email, access_token, refresh_token, token_expires_at, onboarded_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        'user-existing-onboarded',
        'spotify-onboarded',
        'user2@example.com',
        'old-at',
        'old-rt',
        now + 3600 * 1000,
        now,
        now,
        now
      )
      .run();

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
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind('user-logout-test', 'spotify-logout-test', 'enc-at', 'enc-rt', now + 3600 * 1000, now, now)
      .run();

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
