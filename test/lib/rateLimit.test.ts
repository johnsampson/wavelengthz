import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit } from '../../src/lib/rateLimit';

beforeEach(async () => {
  const list = await env.RATE_LIMIT_KV.list();
  await Promise.all(list.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
});

describe('checkRateLimit', () => {
  it('allows requests under the limit', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await checkRateLimit(env.RATE_LIMIT_KV, 'ip-1', 5, 60)).toBe(true);
    }
  });

  it('blocks the request that exceeds the limit', async () => {
    for (let i = 0; i < 3; i++) {
      await checkRateLimit(env.RATE_LIMIT_KV, 'ip-2', 3, 60);
    }
    expect(await checkRateLimit(env.RATE_LIMIT_KV, 'ip-2', 3, 60)).toBe(false);
  });

  it('tracks separate keys independently', async () => {
    for (let i = 0; i < 3; i++) await checkRateLimit(env.RATE_LIMIT_KV, 'ip-a', 3, 60);
    expect(await checkRateLimit(env.RATE_LIMIT_KV, 'ip-b', 3, 60)).toBe(true);
  });
});
