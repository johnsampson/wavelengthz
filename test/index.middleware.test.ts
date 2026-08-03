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
});
