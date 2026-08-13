import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { markSpotifyCooldown, isSpotifyCoolingDown } from '../../src/lib/spotifyThrottle';

beforeEach(async () => {
  const list = await env.RATE_LIMIT_KV.list();
  await Promise.all(list.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
});

describe('isSpotifyCoolingDown', () => {
  it('returns null when no cooldown has ever been set', async () => {
    expect(await isSpotifyCoolingDown(env.RATE_LIMIT_KV)).toBeNull();
  });
});

describe('markSpotifyCooldown / isSpotifyCoolingDown', () => {
  it('reports an active cooldown with a positive remaining-ms after marking with a specific Retry-After', async () => {
    await markSpotifyCooldown(env.RATE_LIMIT_KV, 5);

    const remaining = await isSpotifyCoolingDown(env.RATE_LIMIT_KV);

    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(0);
    expect(remaining!).toBeLessThanOrEqual(5000);
  });

  it('falls back to the default duration when no Retry-After is given', async () => {
    await markSpotifyCooldown(env.RATE_LIMIT_KV);

    const remaining = await isSpotifyCoolingDown(env.RATE_LIMIT_KV);

    expect(remaining).not.toBeNull();
    // SPOTIFY_COOLDOWN_DEFAULT_SECONDS = 15
    expect(remaining!).toBeGreaterThan(14000);
    expect(remaining!).toBeLessThanOrEqual(15000);
  });

  it('ignores a non-positive or non-finite Retry-After, falling back to the default', async () => {
    await markSpotifyCooldown(env.RATE_LIMIT_KV, -1);

    const remaining = await isSpotifyCoolingDown(env.RATE_LIMIT_KV);

    expect(remaining!).toBeGreaterThan(14000);
    expect(remaining!).toBeLessThanOrEqual(15000);
  });

  it("correctly reports cooldown cleared once the real (short) duration has elapsed, even though the underlying KV row -- floored to Cloudflare's 60s minimum -- has not", async () => {
    // A fractional Retry-After keeps this test fast while still exercising
    // the real gap between the intended ~10ms duration and the KV row's
    // own 60s-floored expirationTtl.
    await markSpotifyCooldown(env.RATE_LIMIT_KV, 0.01);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await isSpotifyCoolingDown(env.RATE_LIMIT_KV)).toBeNull();
    // The KV row itself is still there (60s floor) -- only the *reported*
    // cooldown state has cleared, proving isSpotifyCoolingDown reads the
    // stored expiry rather than relying on the KV row's own TTL.
    expect(await env.RATE_LIMIT_KV.get('spotify-cooldown')).not.toBeNull();
  });
});
