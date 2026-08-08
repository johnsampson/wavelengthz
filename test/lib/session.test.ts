import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession, getSessionUser, sessionCookieHeader, requestIsSecure, requestProtocol } from '../../src/lib/session';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM users;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'spotify-u1', 'enc-access', 'enc-refresh', 9999999999, 1000, 1000)`
  ).run();
});

describe('session', () => {
  it('creates a session row and returns a Set-Cookie-ready cookie string', async () => {
    const { id, cookie } = await createSession(env.DB, 'u1');
    expect(id).toBeTruthy();
    expect(cookie).toContain('wl_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('omits Secure when told the request was not over https', async () => {
    // Safari (unlike Chromium) refuses to store a `Secure` cookie over plain
    // HTTP even for localhost/127.0.0.1, so local dev over http://127.0.0.1
    // needs the attribute dropped or the cookie silently never gets set --
    // which is indistinguishable from the browser just not sending it back.
    const { cookie } = await createSession(env.DB, 'u1', false);
    expect(cookie).toContain('wl_session=');
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('resolves the user from a request carrying the session cookie', async () => {
    const { id } = await createSession(env.DB, 'u1');
    const req = new Request('http://localhost/api/me', {
      headers: { Cookie: `wl_session=${id}` },
    });
    const user = await getSessionUser(req, env.DB);
    expect(user?.id).toBe('u1');
  });

  it('returns null when there is no session cookie', async () => {
    const req = new Request('http://localhost/api/me');
    const user = await getSessionUser(req, env.DB);
    expect(user).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const id = 'expired-session';
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 'u1', 1000, 1001)`
    ).bind(id).run();
    const req = new Request('http://localhost/api/me', {
      headers: { Cookie: `wl_session=${id}` },
    });
    const user = await getSessionUser(req, env.DB);
    expect(user).toBeNull();
  });
});

describe('requestIsSecure / requestProtocol', () => {
  it('is true for a plain https request URL, with no CF-Visitor header', () => {
    const req = new Request('https://wavelengthz.app/login');
    expect(requestIsSecure(req)).toBe(true);
    expect(requestProtocol(req)).toBe('https:');
  });

  it('is false for a plain http request URL, with no CF-Visitor header', () => {
    const req = new Request('http://127.0.0.1:8787/login');
    expect(requestIsSecure(req)).toBe(false);
    expect(requestProtocol(req)).toBe('http:');
  });

  it('trusts CF-Visitor https over an http request URL -- the Cloudflare Tunnel case', () => {
    // cloudflared terminates TLS at Cloudflare's edge but proxies to a local
    // http origin without forwarding X-Forwarded-Proto (a documented gap:
    // github.com/cloudflare/cloudflared/issues/1245), so the Worker's own
    // request.url looks like plain http even though the public/browser side
    // is genuinely https. CF-Visitor is set reliably regardless.
    const req = new Request('http://local.wavelengthz.com/login', {
      headers: { 'CF-Visitor': '{"scheme":"https"}' },
    });
    expect(requestIsSecure(req)).toBe(true);
    expect(requestProtocol(req)).toBe('https:');
  });

  it('trusts CF-Visitor http over an https request URL', () => {
    const req = new Request('https://example.com/login', {
      headers: { 'CF-Visitor': '{"scheme":"http"}' },
    });
    expect(requestIsSecure(req)).toBe(false);
    expect(requestProtocol(req)).toBe('http:');
  });

  it('falls back to the request URL protocol when CF-Visitor is malformed', () => {
    const req = new Request('https://example.com/login', {
      headers: { 'CF-Visitor': 'not-json' },
    });
    expect(requestIsSecure(req)).toBe(true);
  });
});
