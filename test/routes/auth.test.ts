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
    const req = new Request('http://localhost/login');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('https://accounts.spotify.com/authorize');
    const setCookie = res.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('wl_oauth_state=');
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
    expect(res.headers.get('Set-Cookie')).toContain('wl_session=');

    const row = await env.DB.prepare('SELECT * FROM users WHERE spotify_id = ?')
      .bind('spotify-xyz')
      .first<any>();
    expect(row).toBeTruthy();
    expect(row.email).toBe('user@example.com');
    expect(row.access_token).not.toBe('at'); // encrypted, not plaintext

    vi.unstubAllGlobals();
  });

  it('redirects an existing user whose onboarding is incomplete to /onboarding.html', async () => {
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
    expect(res.headers.get('Location')).toBe('/onboarding.html');

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
