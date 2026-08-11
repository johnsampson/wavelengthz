import { describe, it, expect, vi } from 'vitest';
import { checkNudity, classifyNudityScore } from '../../src/lib/sightengine';

describe('classifyNudityScore', () => {
  it('is approved below the flag threshold', () => {
    expect(classifyNudityScore(0.1)).toBe('approved');
  });

  it('is flagged at exactly the flag threshold', () => {
    expect(classifyNudityScore(0.5)).toBe('flagged');
  });

  it('is flagged just under the block threshold', () => {
    expect(classifyNudityScore(0.85)).toBe('flagged');
  });

  it('is blocked just over the block threshold', () => {
    expect(classifyNudityScore(0.851)).toBe('blocked');
  });

  it('is blocked at the maximum score', () => {
    expect(classifyNudityScore(1)).toBe('blocked');
  });
});

describe('checkNudity', () => {
  it('no-ops as approved with a null score when credentials are not configured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await checkNudity(new ArrayBuffer(0), 'image/jpeg', {} as any);

    expect(result).toEqual({ status: 'approved', score: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  const env = { SIGHTENGINE_API_USER: 'user', SIGHTENGINE_API_SECRET: 'secret' } as any;

  it('classifies a clean image as approved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ nudity: { none: 0.98 } }), { status: 200 })));

    const result = await checkNudity(new ArrayBuffer(0), 'image/jpeg', env);

    expect(result.status).toBe('approved');
    expect(result.score).toBeCloseTo(0.02, 5);
    vi.unstubAllGlobals();
  });

  it('classifies a high-risk image as blocked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ nudity: { none: 0.05 } }), { status: 200 })));

    const result = await checkNudity(new ArrayBuffer(0), 'image/jpeg', env);

    expect(result.status).toBe('blocked');
    expect(result.score).toBeCloseTo(0.95, 5);
    vi.unstubAllGlobals();
  });

  it('sends the expected multipart fields and auth', async () => {
    let sentBody: FormData | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = init.body as FormData;
        return new Response(JSON.stringify({ nudity: { none: 1 } }), { status: 200 });
      })
    );

    await checkNudity(new ArrayBuffer(0), 'image/png', env);

    expect(sentBody?.get('models')).toBe('nudity-2.1');
    expect(sentBody?.get('api_user')).toBe('user');
    expect(sentBody?.get('api_secret')).toBe('secret');
    vi.unstubAllGlobals();
  });

  it('treats a missing/unrecognized response shape as maximally uncertain, not as clean', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));

    const result = await checkNudity(new ArrayBuffer(0), 'image/jpeg', env);

    expect(result.status).toBe('blocked');
    expect(result.score).toBe(1);
    vi.unstubAllGlobals();
  });

  it('throws on a non-OK response, matching this codebase\'s other API clients', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 503 })));

    await expect(checkNudity(new ArrayBuffer(0), 'image/jpeg', env)).rejects.toThrow(/503/);
    vi.unstubAllGlobals();
  });
});
