import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applySchema } from './apply-schema';
import worker from '../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

describe('worker root', () => {
  it('returns 404 for an unknown route', async () => {
    const req = new Request('http://localhost/does-not-exist');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(404);
  });

  it('adds security headers to every Worker-generated response', async () => {
    const req = new Request('http://localhost/does-not-exist');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('DB binding has the users table after schema apply', async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
    ).first();
    expect(result?.name).toBe('users');
  });
});

describe('pre-launch site-wide password gate', () => {
  // wrangler.toml's [env.test.vars] deliberately omits SITE_BASIC_AUTH_USER/
  // PASSWORD -- unset means the gate is a no-op, which every other test in
  // this suite already relies on.
  it('is a no-op when unconfigured', async () => {
    const req = new Request('http://localhost/does-not-exist');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(404); // reaches the normal 404, not a 401
  });

  it('returns 401 with no credentials when configured', async () => {
    const gatedEnv = { ...env, SITE_BASIC_AUTH_USER: 'preview', SITE_BASIC_AUTH_PASSWORD: 'letmein' };
    const req = new Request('http://localhost/api/me');
    const res = await worker.fetch(req, gatedEnv, {} as ExecutionContext);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
  });

  it('returns 401 with wrong credentials', async () => {
    const gatedEnv = { ...env, SITE_BASIC_AUTH_USER: 'preview', SITE_BASIC_AUTH_PASSWORD: 'letmein' };
    const req = new Request('http://localhost/api/me', {
      headers: { Authorization: 'Basic ' + btoa('preview:wrong') },
    });
    const res = await worker.fetch(req, gatedEnv, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('passes through to the normal response with the right credentials', async () => {
    const gatedEnv = { ...env, SITE_BASIC_AUTH_USER: 'preview', SITE_BASIC_AUTH_PASSWORD: 'letmein' };
    const req = new Request('http://localhost/does-not-exist', {
      headers: { Authorization: 'Basic ' + btoa('preview:letmein') },
    });
    const res = await worker.fetch(req, gatedEnv, {} as ExecutionContext);
    expect(res.status).toBe(404); // past the gate, into the normal (unmatched-route) response
  });

  it('applies before rate limiting or routing -- even to paths that would otherwise 404', async () => {
    const gatedEnv = { ...env, SITE_BASIC_AUTH_USER: 'preview', SITE_BASIC_AUTH_PASSWORD: 'letmein' };
    const req = new Request('http://localhost/anything-at-all');
    const res = await worker.fetch(req, gatedEnv, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });
});
