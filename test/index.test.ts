import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
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

  // manifest.json and the touch-icon files are the exception: iOS/Android's
  // "Add to Home Screen" fetches them as unauthenticated background requests
  // that can never carry Basic Auth credentials, so gating them meant the
  // install icon silently 401'd and fell back to a default letter avatar.
  it('exempts manifest.json and the PWA icon files from the gate', async () => {
    const gatedEnv = { ...env, SITE_BASIC_AUTH_USER: 'preview', SITE_BASIC_AUTH_PASSWORD: 'letmein' };
    for (const path of ['/manifest.json', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png']) {
      const req = new Request(`http://localhost${path}`);
      const res = await worker.fetch(req, gatedEnv, {} as ExecutionContext);
      // Past the gate, into the real ASSETS binding (bound in the test
      // harness too, unlike the plain-404 fallback the other tests here
      // rely on) -- these files genuinely exist under public/, so a real
      // 200 is the actual proof the gate let the request through.
      expect(res.status).toBe(200);
    }
  });

  it('still gates a similarly-named path that is not on the exemption list', async () => {
    const gatedEnv = { ...env, SITE_BASIC_AUTH_USER: 'preview', SITE_BASIC_AUTH_PASSWORD: 'letmein' };
    const req = new Request('http://localhost/icons/some-other-file.png');
    const res = await worker.fetch(req, gatedEnv, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  // Deliberate, known hole (see the exemption list's own comment in
  // src/index.ts): iOS's installed PWA can't reliably carry Basic Auth
  // credentials through the Spotify OAuth redirect chain, so Spotify login
  // failed 100% of the time from the home-screen app while working fine
  // from a regular browser tab. Exempted so it works from both, at the
  // accepted cost of these two URLs being reachable without the site
  // password pre-launch.
  it('exempts /login/spotify and /callback from the gate', async () => {
    const gatedEnv = { ...env, SITE_BASIC_AUTH_USER: 'preview', SITE_BASIC_AUTH_PASSWORD: 'letmein' };

    const loginRes = await worker.fetch(new Request('http://localhost/login/spotify'), gatedEnv, {} as ExecutionContext);
    expect(loginRes.status).toBe(302); // past the gate, into the real route handler's Spotify redirect

    const callbackRes = await worker.fetch(new Request('http://localhost/callback'), gatedEnv, {} as ExecutionContext);
    expect(callbackRes.status).toBe(400); // past the gate, into the real route handler's "Invalid OAuth state"
  });

  it('still gates /login/google and /callback/google -- the exemption is Spotify-only', async () => {
    const gatedEnv = { ...env, SITE_BASIC_AUTH_USER: 'preview', SITE_BASIC_AUTH_PASSWORD: 'letmein' };

    const loginRes = await worker.fetch(new Request('http://localhost/login/google'), gatedEnv, {} as ExecutionContext);
    expect(loginRes.status).toBe(401);

    const callbackRes = await worker.fetch(new Request('http://localhost/callback/google'), gatedEnv, {} as ExecutionContext);
    expect(callbackRes.status).toBe(401);
  });
});

// A cron string that doesn't exactly match its `else if` in the scheduled
// handler silently falls through to the final `else` (purgeExpiredDeletions)
// and the intended job simply never runs -- with nothing anywhere to notice.
// These pin the string in wrangler.toml's `crons` to the branch it's meant
// to reach.
describe('scheduled() cron dispatch', () => {
  function capturingCtx() {
    const pending: Promise<unknown>[] = [];
    return { ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext, pending };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes "30 */6 * * *" to artist-only catalog discovery', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        calls.push(url);
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('/v1/search')) return new Response(JSON.stringify({ artists: { items: [] } }), { status: 200 });
        throw new Error(`unexpected fetch ${url}`);
      })
    );
    const { ctx, pending } = capturingCtx();

    await worker.scheduled({ cron: '30 */6 * * *', scheduledTime: Date.now() } as ScheduledEvent, env, ctx);
    await Promise.all(pending);

    expect(calls.some((c) => c.includes('/v1/search') && c.includes('type=artist'))).toBe(true);
    // The whole point of this job: catalog growth that never spends a track call.
    expect(calls.some((c) => c.includes('/tracks') || c.includes('/albums'))).toBe(false);
  });

  it('does not run discovery for a cron string it does not own', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        calls.push(input.toString());
        return new Response('{}', { status: 200 });
      })
    );
    const { ctx, pending } = capturingCtx();

    // The nightly purge branch -- touches D1 only, never Spotify.
    await worker.scheduled({ cron: '0 3 * * *', scheduledTime: Date.now() } as ScheduledEvent, env, ctx);
    await Promise.all(pending);

    expect(calls.some((c) => c.includes('/v1/search'))).toBe(false);
  });
});
