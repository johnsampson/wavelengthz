import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
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

  it('passes a ?count= query param through as the target and reports it back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
        if (url.includes('/v1/search')) return new Response(JSON.stringify({ artists: { items: [] } }), { status: 200 });
        throw new Error(`unexpected ${url}`);
      })
    );
    const req = new Request('http://localhost/internal/seed?count=1000', {
      method: 'POST',
      headers: { 'X-Seed-Secret': env.SEED_SECRET },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.requestedTotal).toBe(1000);
    vi.unstubAllGlobals();
  });

  it('rejects a non-numeric or non-positive ?count= with 400, without touching Spotify', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const bad of ['not-a-number', '0', '-5']) {
      const req = new Request(`http://localhost/internal/seed?count=${bad}`, {
        method: 'POST',
        headers: { 'X-Seed-Secret': env.SEED_SECRET },
      });
      const res = await worker.fetch(req, env, {} as ExecutionContext);
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('POST /internal/users/:id/delete', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM sessions; DELETE FROM users;');
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES ('u1', 'spotify-u1', 'a', 'r', 9999999999999, 1000, 1000)`
    ).run();
  });

  it('rejects requests without the correct seed secret', async () => {
    const req = new Request('http://localhost/internal/users/u1/delete', { method: 'POST' });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first()).not.toBeNull();
  });

  it('hard-deletes a user looked up by internal id', async () => {
    const req = new Request('http://localhost/internal/users/u1/delete', {
      method: 'POST',
      headers: { 'X-Seed-Secret': env.SEED_SECRET },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first()).toBeNull();
  });

  it('hard-deletes a user looked up by spotify_id', async () => {
    const req = new Request('http://localhost/internal/users/spotify-u1/delete', {
      method: 'POST',
      headers: { 'X-Seed-Secret': env.SEED_SECRET },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first()).toBeNull();
  });

  it('returns 404 for an id that matches no user', async () => {
    const req = new Request('http://localhost/internal/users/does-not-exist/delete', {
      method: 'POST',
      headers: { 'X-Seed-Secret': env.SEED_SECRET },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(404);
  });
});
