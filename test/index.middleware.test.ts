import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from './apply-schema';
import worker from '../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  const list = await env.RATE_LIMIT_KV.list();
  await Promise.all(list.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
});

describe('global middleware', () => {
  it('rate-limits swipe endpoints tighter than general /api/* traffic', async () => {
    const makeSwipeReq = () =>
      new Request('http://localhost/api/swipe/music', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '1.2.3.4', 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: 'artist', item_id: 'a1', direction: 'left' }),
      });

    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      const res = await worker.fetch(makeSwipeReq(), env, {} as ExecutionContext);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('rate-limits /callback, where OAuth actually creates accounts', async () => {
    // /callback was excluded entirely: the middleware only matched `/api/`,
    // so the one endpoint that creates accounts was the one endpoint with no
    // limit at all.
    // Stubbed so the 20 allowed requests don't make real outbound calls to
    // Spotify; only the 429 on the 21st is under test here.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    const makeCallbackReq = () =>
      new Request('http://localhost/callback?code=x&state=y', {
        headers: { Cookie: 'wl_oauth_state=y', 'CF-Connecting-IP': '5.5.5.5' },
      });

    let lastStatus = 0;
    for (let i = 0; i < 21; i++) {
      const res = await worker.fetch(makeCallbackReq(), env, {} as ExecutionContext);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);

    vi.unstubAllGlobals();
  });

  it('rate-limits GET .../messages polling (matches and groups) in its own bucket', async () => {
    const makePollReq = (path: string) => new Request(`http://localhost${path}`, { headers: { 'CF-Connecting-IP': '6.6.6.1' } });

    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      const res = await worker.fetch(makePollReq('/api/matches/m1/messages'), env, {} as ExecutionContext);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);

    const groupRes = await worker.fetch(makePollReq('/api/groups/g1/messages'), env, {} as ExecutionContext);
    // Same bucket (keyed by IP, not by conversation) -- already exhausted by
    // the matches polling above.
    expect(groupRes.status).toBe(429);
  });

  it('does not let message/group polling starve unrelated /api/ traffic sharing the same IP', async () => {
    // Regression: GET .../messages used to share the general 120/min bucket
    // with every other /api/ call. public/messages.html and public/group.html
    // both poll every 3s while visible (20 req/min per open tab) -- a couple
    // of open chat tabs alone permanently saturated that shared budget, so
    // an unrelated action (loading an artist, etc.) got 429'd right along
    // with it and never recovered, since the polling never stopped refilling
    // the bucket faster than it could empty.
    const ip = '6.6.6.2';
    const pollReq = () => new Request('http://localhost/api/matches/m1/messages', { headers: { 'CF-Connecting-IP': ip } });

    // Well past even the OLD shared general budget (120/min), to prove this
    // traffic no longer counts against it at all.
    for (let i = 0; i < 150; i++) {
      await worker.fetch(pollReq(), env, {} as ExecutionContext);
    }

    const unrelatedReq = new Request('http://localhost/api/me', { headers: { 'CF-Connecting-IP': ip } });
    const res = await worker.fetch(unrelatedReq, env, {} as ExecutionContext);
    expect(res.status).not.toBe(429);
  });

  it('does not exempt POSTing a message (sending, not polling) from the general bucket', async () => {
    // isPollPath is GET-only -- guards against the message-*send* endpoint
    // (same path, POST) accidentally getting the loose polling budget
    // instead of general's tighter spam protection.
    const ip = '6.6.6.3';
    const sendReq = () =>
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      });

    let lastStatus = 0;
    for (let i = 0; i < 121; i++) {
      const res = await worker.fetch(sendReq(), env, {} as ExecutionContext);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('reports a KV failure during rate limiting to Sentry, but fails open instead of 500ing the request', async () => {
    // A KV outage during a rate-limit check used to propagate as an
    // unhandled exception -- at one point invisibly (before Sentry
    // reporting existed here), and after that as a reported but very real
    // 500 for an otherwise-ordinary request. Production hit this directly:
    // KV writes are limited to roughly one per second per key, and any
    // client sharing a rate-limit bucket faster than that (a busy user, a
    // NAT/corporate shared IP) throws here under real traffic. Rate
    // limiting is best-effort defense, not core functionality, so this must
    // now fail open (allow the request through to the real route) while
    // still reporting the KV failure for visibility.
    const sentryCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        sentryCalls.push(String(url));
        return new Response('', { status: 200 });
      })
    );

    const brokenKv = {
      get: async () => {
        throw new Error('KV namespace unavailable');
      },
      put: async () => {},
    };
    const brokenEnv = { ...env, RATE_LIMIT_KV: brokenKv } as any;

    const res = await worker.fetch(
      new Request('http://localhost/api/me', { headers: { 'CF-Connecting-IP': '7.7.7.7' } }),
      brokenEnv,
      {} as ExecutionContext
    );

    // Falls through to the real /api/me handler, which correctly 401s here
    // since the request carries no session -- not the 500 a blocked rate
    // limiter used to produce.
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('KV namespace unavailable');
    expect(sentryCalls.some((u) => u.includes('/envelope/'))).toBe(true);

    vi.unstubAllGlobals();
  });

  it('returns a distinct 503 (not the generic 500) when Spotify is still rate-limiting a route after spotifyFetch\'s own retry', async () => {
    // Regression: this was reported as "constantly 429" loading an artist,
    // where the underlying failure -- Spotify's own rate limit, tripped by
    // GET /api/artists/:id's fan-out to dozens of parallel calls -- was
    // indistinguishable from any other server failure, since both landed on
    // the same generic 500. /callback's token exchange is a simpler way to
    // exercise the same spotifyFetch path end to end than standing up a full
    // artist-load fixture.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.001' } }))
    );
    const callbackReq = new Request('http://localhost/callback?code=x&state=y', {
      headers: { Cookie: 'wl_oauth_state=y', 'CF-Connecting-IP': '9.9.9.6' },
    });

    const res = await worker.fetch(callbackReq, env, {} as ExecutionContext);

    expect(res.status).toBe(503);
    const body = await res.json<any>();
    expect(body.error).toBe('spotify_rate_limited');
    vi.unstubAllGlobals();
  });

  it('returns a generic 500 and does not leak error internals when a route throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('downstream Spotify outage'); }));
    const req = new Request('http://localhost/login', { headers: { 'CF-Connecting-IP': '9.9.9.9' } });
    // /login itself doesn't call fetch, so force a throwing path via callback with a broken code exchange:
    const callbackReq = new Request('http://localhost/callback?code=x&state=y', {
      headers: { Cookie: 'wl_oauth_state=y', 'CF-Connecting-IP': '9.9.9.8' },
    });
    const res = await worker.fetch(callbackReq, env, {} as ExecutionContext);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('downstream Spotify outage');
    vi.unstubAllGlobals();
  });

  it('logs the real error and request path to the console so a local dev session without a real Sentry project can still see what broke', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('downstream Spotify outage'); }));
    const callbackReq = new Request('http://localhost/callback?code=x&state=y', {
      headers: { Cookie: 'wl_oauth_state=y', 'CF-Connecting-IP': '9.9.9.7' },
    });

    await worker.fetch(callbackReq, env, {} as ExecutionContext);

    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedText = consoleErrorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedText).toContain('downstream Spotify outage');
    expect(loggedText).toContain('/callback');

    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
