import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import worker from '../../src/index';
import { insertTestUser } from '../helpers/createUser';

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

describe('POST /internal/enrich-genres', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM artist_genres').run();
    await env.DB.prepare('DELETE FROM artists').run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects requests without the correct seed secret', async () => {
    const req = new Request('http://localhost/internal/enrich-genres', { method: 'POST' });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('runs enrichment and returns counts when the secret matches', async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at) VALUES ('a1', 'sp1', 'A1', '{}', 'seed', 1, 1000)`
    ).run();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ urls: [] }), { status: 200 })));

    vi.useFakeTimers();
    const req = new Request('http://localhost/internal/enrich-genres', {
      method: 'POST',
      headers: { 'X-Seed-Secret': env.SEED_SECRET },
    });
    const resPromise = worker.fetch(req, env, {} as ExecutionContext);
    await vi.runAllTimersAsync();
    const res = await resPromise;

    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toEqual({ attempted: 1, matched: 0, noMbidMatch: 1, matchedButNoGenres: 0, failed: 0 });
    vi.unstubAllGlobals();
  });

  it('rejects a non-numeric or non-positive ?count= with 400, without touching MusicBrainz', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const bad of ['not-a-number', '0', '-5']) {
      const req = new Request(`http://localhost/internal/enrich-genres?count=${bad}`, {
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

describe('POST /internal/enrich-genres/hourly', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM artist_genres').run();
    await env.DB.prepare('DELETE FROM artists').run();
    await env.DB.prepare('DELETE FROM genres').run();
    await env.RATE_LIMIT_KV.delete('musicbrainz-enrichment-lock');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects requests without the correct seed secret', async () => {
    const req = new Request('http://localhost/internal/enrich-genres/hourly', { method: 'POST' });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('runs the same deadline-and-lock-governed function the hourly cron uses, including the genre-density phase', async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at) VALUES ('a1', 'sp1', 'A1', '{}', 'seed', 1, 1000)`
    ).run();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ urls: [] }), { status: 200 })));

    vi.useFakeTimers();
    const req = new Request('http://localhost/internal/enrich-genres/hourly', {
      method: 'POST',
      headers: { 'X-Seed-Secret': env.SEED_SECRET },
    });
    const resPromise = worker.fetch(req, env, {} as ExecutionContext);
    await vi.runAllTimersAsync();
    const res = await resPromise;

    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toEqual({
      artists: { attempted: 1, matched: 0, noMbidMatch: 1, matchedButNoGenres: 0, failed: 0 },
      genreDensity: { attempted: 0, updated: 0, failed: 0 },
    });
    expect(await env.RATE_LIMIT_KV.get('musicbrainz-enrichment-lock')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('reports skipped rather than double-running when a run is already in flight', async () => {
    await env.RATE_LIMIT_KV.put('musicbrainz-enrichment-lock', '1', { expirationTtl: 3600 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = new Request('http://localhost/internal/enrich-genres/hourly', {
      method: 'POST',
      headers: { 'X-Seed-Secret': env.SEED_SECRET },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toEqual({ skipped: true, reason: 'already_running' });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('POST /internal/enrich-genre-density', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM genres').run();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects requests without the correct seed secret', async () => {
    const req = new Request('http://localhost/internal/enrich-genre-density', { method: 'POST' });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('runs density fetching and returns counts when the secret matches', async () => {
    await env.DB.prepare(
      `INSERT INTO genres (id, genre, artist_count, track_count, created_at, updated_at) VALUES ('g1', 'pop', 1, 0, 1000, 1000)`
    ).run();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 29075 }), { status: 200 })));

    const req = new Request('http://localhost/internal/enrich-genre-density', {
      method: 'POST',
      headers: { 'X-Seed-Secret': env.SEED_SECRET },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toEqual({ attempted: 1, updated: 1, failed: 0 });
  });

  it('rejects a non-numeric or non-positive ?count= with 400, without touching MusicBrainz', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const bad of ['not-a-number', '0', '-5']) {
      const req = new Request(`http://localhost/internal/enrich-genre-density?count=${bad}`, {
        method: 'POST',
        headers: { 'X-Seed-Secret': env.SEED_SECRET },
      });
      const res = await worker.fetch(req, env, {} as ExecutionContext);
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /internal/users/:id/delete', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'spotify-u1' });
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

// Issue #161 (part of the 250K-users strategy discussion): the report
// endpoint applicants would eventually export for Spotify's own Extended
// Quota Mode MAU verification.
describe('GET /internal/analytics/mau', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM analytics_events; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
    await insertTestUser(env.DB, { id: 'u1' });
    await env.DB.prepare(
      `INSERT INTO analytics_events (id, user_id, event_type, created_at, updated_at) VALUES ('e1', 'u1', 'session_start', ?, ?)`
    )
      .bind(Date.now() - 5 * 24 * 60 * 60 * 1000, Date.now() - 5 * 24 * 60 * 60 * 1000)
      .run();
    await env.DB.prepare(
      `INSERT INTO analytics_events (id, user_id, event_type, created_at, updated_at) VALUES ('e2', 'u1', 'song_play', ?, ?)`
    )
      .bind(Date.now() - 40 * 24 * 60 * 60 * 1000, Date.now() - 40 * 24 * 60 * 60 * 1000)
      .run();
    await env.DB.prepare(
      `INSERT INTO analytics_events (id, user_id, event_type, created_at, updated_at) VALUES ('e3', NULL, 'session_start', ?, ?)`
    )
      .bind(Date.now() - 5 * 24 * 60 * 60 * 1000, Date.now() - 5 * 24 * 60 * 60 * 1000)
      .run();
  });

  it('rejects requests without the correct seed secret', async () => {
    const req = new Request('http://localhost/internal/analytics/mau', { method: 'GET' });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('reports distinct active users and anonymous events within the default 30-day window, excluding older rows', async () => {
    const req = new Request('http://localhost/internal/analytics/mau', {
      headers: { 'X-Seed-Secret': env.SEED_SECRET },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.days).toBe(30);
    expect(body.distinctUsers).toBe(1); // u1's recent event counts once, its 40-day-old one doesn't extend the window
    expect(body.anonymousEvents).toBe(1);
  });

  it('honors a ?days= override', async () => {
    const req = new Request('http://localhost/internal/analytics/mau?days=45', {
      headers: { 'X-Seed-Secret': env.SEED_SECRET },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.days).toBe(45);
    expect(body.distinctUsers).toBe(1); // now both of u1's events (5 and 40 days old) fall inside the window
  });

  it('rejects a non-numeric or non-positive ?days=', async () => {
    for (const bad of ['not-a-number', '0', '-5']) {
      const req = new Request(`http://localhost/internal/analytics/mau?days=${bad}`, {
        headers: { 'X-Seed-Secret': env.SEED_SECRET },
      });
      const res = await worker.fetch(req, env, {} as ExecutionContext);
      expect(res.status).toBe(400);
    }
  });
});
