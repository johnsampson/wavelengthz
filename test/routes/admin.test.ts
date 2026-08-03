import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

describe('POST /internal/seed', () => {
  it('rejects requests without the correct seed secret', async () => {
    const req = new Request('http://localhost/internal/seed', { method: 'POST' });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('runs the seed and returns counts when the secret matches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
        if (url.includes('/v1/search')) return new Response(JSON.stringify({ artists: { items: [] } }), { status: 200 });
        throw new Error(`unexpected ${url}`);
      })
    );
    const req = new Request('http://localhost/internal/seed', {
      method: 'POST',
      headers: { 'X-Seed-Secret': env.SEED_SECRET },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.artistsInserted).toBe(0);
    vi.unstubAllGlobals();
  });
});
