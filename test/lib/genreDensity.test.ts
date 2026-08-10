import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { fetchGenreDensities } from '../../src/lib/genreDensity';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM genres').run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function insertGenre(id: string, genre: string, createdAt = 1000) {
  await env.DB.prepare(
    `INSERT INTO genres (id, genre, artist_count, track_count, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?)`
  )
    .bind(id, genre, createdAt, createdAt)
    .run();
}

function stubDensity(count: number) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count }), { status: 200 })));
}

async function run(options?: { limit?: number; deadline?: number }) {
  vi.useFakeTimers();
  const resultPromise = fetchGenreDensities(env.DB, options);
  await vi.runAllTimersAsync();
  return resultPromise;
}

describe('fetchGenreDensities', () => {
  it('stores the corpus-wide count and marks the genre as fetched', async () => {
    await insertGenre('g1', 'pop');
    stubDensity(29075);

    const result = await run();

    expect(result).toEqual({ attempted: 1, updated: 1, failed: 0 });
    const row = await env.DB.prepare('SELECT musicbrainz_artist_count, musicbrainz_density_fetched_at FROM genres WHERE id = ?').bind('g1').first<any>();
    expect(row.musicbrainz_artist_count).toBe(29075);
    expect(row.musicbrainz_density_fetched_at).not.toBeNull();
  });

  it('never re-fetches a genre that already has a density recorded', async () => {
    await insertGenre('g1', 'pop');
    await env.DB.prepare('UPDATE genres SET musicbrainz_density_fetched_at = ? WHERE id = ?').bind(999, 'g1').run();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await run();

    expect(result.attempted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves musicbrainz_density_fetched_at unset on a failed lookup, so it retries later', async () => {
    await insertGenre('g1', 'pop');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 503 })));

    const result = await run();

    expect(result).toEqual({ attempted: 1, updated: 0, failed: 1 });
    const row = await env.DB.prepare('SELECT musicbrainz_density_fetched_at FROM genres WHERE id = ?').bind('g1').first<any>();
    expect(row.musicbrainz_density_fetched_at).toBeNull();
  });

  it('processes the longest-waiting genres first', async () => {
    await insertGenre('newer', 'indie', 5000);
    await insertGenre('older', 'pop', 1000);
    stubDensity(100);

    await run({ limit: 1 });

    const older = await env.DB.prepare('SELECT musicbrainz_density_fetched_at FROM genres WHERE id = ?').bind('older').first<any>();
    const newer = await env.DB.prepare('SELECT musicbrainz_density_fetched_at FROM genres WHERE id = ?').bind('newer').first<any>();
    expect(older.musicbrainz_density_fetched_at).not.toBeNull();
    expect(newer.musicbrainz_density_fetched_at).toBeNull();
  });

  it('stops starting new genres once the deadline has passed, but finishes one already in flight', async () => {
    await insertGenre('g1', 'pop');
    await insertGenre('g2', 'indie');
    stubDensity(100);

    vi.useFakeTimers();
    const start = Date.now();
    const resultPromise = fetchGenreDensities(env.DB, { deadline: start + 500 });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.attempted).toBe(1);
    const remaining = await env.DB.prepare('SELECT COUNT(*) as c FROM genres WHERE musicbrainz_density_fetched_at IS NULL').first<{ c: number }>();
    expect(remaining!.c).toBe(1);
  });
});
