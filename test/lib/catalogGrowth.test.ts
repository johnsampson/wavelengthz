import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { growOneGenre } from '../../src/lib/catalogGrowth';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM genres; DELETE FROM tracks; DELETE FROM artists; DELETE FROM genre_search_cursors; DELETE FROM catalog_growth_runs;'
  );
});

function stubArtistSearch(items: any[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('type=artist')) return new Response(JSON.stringify({ artists: { items } }), { status: 200 });
      if (url.includes('/albums')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      throw new Error(`unexpected ${url}`);
    })
  );
}

describe('growOneGenre', () => {
  it('inserts new artists and advances the cursor by a full page', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`, name: `Artist ${i}`, genres: ['pop'], images: [{ url: `https://img/${i}.jpg` }], popularity: 50,
    }));
    stubArtistSearch(items);

    const result = await growOneGenre(env.DB, 'token', 'pop', 1000);

    expect(result.inserted).toBe(10);
    const cursor = await env.DB.prepare('SELECT search_offset, exhausted FROM genre_search_cursors WHERE genre = ?').bind('pop').first<any>();
    expect(cursor.search_offset).toBe(10);
    expect(cursor.exhausted).toBe(0);
    vi.unstubAllGlobals();
  });

  it('marks the genre exhausted when a page comes back shorter than a full page', async () => {
    stubArtistSearch([{ id: 'a1', name: 'Solo Artist', genres: ['jazz'], images: [{ url: 'https://img/a1.jpg' }], popularity: 50 }]);

    await growOneGenre(env.DB, 'token', 'jazz', 1000);

    const cursor = await env.DB.prepare('SELECT exhausted FROM genre_search_cursors WHERE genre = ?').bind('jazz').first<any>();
    expect(cursor.exhausted).toBe(1);
    vi.unstubAllGlobals();
  });

  it('skips an artist with no photo but still advances the cursor', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, name: `Artist ${i}`, genres: [], images: [], popularity: 50 }));
    stubArtistSearch(items);

    const result = await growOneGenre(env.DB, 'token', 'rock', 1000);

    expect(result.inserted).toBe(0);
    const cursor = await env.DB.prepare('SELECT search_offset FROM genre_search_cursors WHERE genre = ?').bind('rock').first<any>();
    expect(cursor.search_offset).toBe(10);
    vi.unstubAllGlobals();
  });

  it('skips an artist already in the catalog', async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, image_url, source, approved, created_at) VALUES ('x', 'a1', 'Existing', '{}', '/x.jpg', 'seed', 1, 1000)`
    ).run();
    stubArtistSearch([{ id: 'a1', name: 'Existing', genres: [], images: [{ url: '/x.jpg' }], popularity: 50 }]);

    const result = await growOneGenre(env.DB, 'token', 'indie', 1000);

    expect(result.inserted).toBe(0);
    vi.unstubAllGlobals();
  });

  it('does not call Spotify once the offset has walked past the max, and marks exhausted', async () => {
    await env.DB.prepare(
      `INSERT INTO genre_search_cursors (genre, search_offset, exhausted, updated_at) VALUES ('metal', 960, 0, 1000)`
    ).run();
    const fetchMock = vi.fn(async () => {
      throw new Error('should not be called');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await growOneGenre(env.DB, 'token', 'metal', 2000);

    expect(result.inserted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const cursor = await env.DB.prepare('SELECT exhausted FROM genre_search_cursors WHERE genre = ?').bind('metal').first<any>();
    expect(cursor.exhausted).toBe(1);
    vi.unstubAllGlobals();
  });

  it('leaves the cursor untouched and rethrows when the Spotify search fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));

    await expect(growOneGenre(env.DB, 'token', 'folk', 1000)).rejects.toThrow();

    const cursor = await env.DB.prepare('SELECT * FROM genre_search_cursors WHERE genre = ?').bind('folk').first();
    expect(cursor).toBeNull(); // never created -- no progress recorded on failure
    vi.unstubAllGlobals();
  });
});

import { growArtistCatalog, GROWTH_GENRES } from '../../src/lib/catalogGrowth';

function stubArtistSearchByGenre(perGenre: (genre: string) => any[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      if (url.includes('type=artist')) {
        const genre = decodeURIComponent(url).match(/genre:"([^"]+)"/)?.[1] ?? '';
        return new Response(JSON.stringify({ artists: { items: perGenre(genre) } }), { status: 200 });
      }
      if (url.includes('/albums')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      throw new Error(`unexpected ${url}`);
    })
  );
}

describe('growArtistCatalog', () => {
  it('tries genres in order and stops once maxInserted is reached', async () => {
    const genresCalled: string[] = [];
    stubArtistSearchByGenre((genre) => {
      genresCalled.push(genre);
      return [{ id: `${genre}-1`, name: genre, genres: [genre], images: [{ url: `https://img/${genre}.jpg` }], popularity: 50 }];
    });

    const result = await growArtistCatalog(env as any, 1000, { maxInserted: 2 });

    expect(result.inserted).toBe(2);
    expect(genresCalled).toEqual([GROWTH_GENRES[0], GROWTH_GENRES[1]]);
    vi.unstubAllGlobals();
  });

  it('stops after maxGenres real Spotify attempts when given', async () => {
    const genresCalled: string[] = [];
    // Every genre returns nothing new, so maxInserted is never reached --
    // only maxGenres bounds how many are tried.
    stubArtistSearchByGenre((genre) => {
      genresCalled.push(genre);
      return [];
    });

    const result = await growArtistCatalog(env as any, 1000, { maxInserted: 100, maxGenres: 3 });

    expect(result.inserted).toBe(0);
    expect(genresCalled.length).toBe(3);
    expect(result.genresTried.length).toBe(3);
    vi.unstubAllGlobals();
  });

  it('skips a genre already marked exhausted without calling Spotify for it', async () => {
    await env.DB.prepare(
      `INSERT INTO genre_search_cursors (genre, search_offset, exhausted, updated_at) VALUES (?, 500, 1, 1000)`
    ).bind(GROWTH_GENRES[0]).run();
    const genresCalled: string[] = [];
    stubArtistSearchByGenre((genre) => {
      genresCalled.push(genre);
      return [{ id: `${genre}-1`, name: genre, genres: [], images: [{ url: 'https://img/x.jpg' }], popularity: 50 }];
    });

    const result = await growArtistCatalog(env as any, 1000, { maxInserted: 1 });

    expect(genresCalled).not.toContain(GROWTH_GENRES[0]);
    expect(result.inserted).toBe(1);
    vi.unstubAllGlobals();
  });

  it('resets every genre cursor once all of them are exhausted', async () => {
    for (const genre of GROWTH_GENRES) {
      await env.DB.prepare(
        `INSERT INTO genre_search_cursors (genre, search_offset, exhausted, updated_at) VALUES (?, 500, 1, 1000)`
      ).bind(genre).run();
    }
    stubArtistSearchByGenre((genre) => [{ id: `${genre}-1`, name: genre, genres: [], images: [{ url: 'https://img/x.jpg' }], popularity: 50 }]);

    const result = await growArtistCatalog(env as any, 2000, { maxInserted: 1 });

    expect(result.inserted).toBe(1); // proves at least one genre was actually tried, not all skipped
    const cursor = await env.DB.prepare('SELECT search_offset, exhausted FROM genre_search_cursors WHERE genre = ?')
      .bind(GROWTH_GENRES[1]) // untried by this call (maxInserted:1 stopped after the first) but still reset
      .first<any>();
    expect(cursor.search_offset).toBe(0);
    expect(cursor.exhausted).toBe(0);
    vi.unstubAllGlobals();
  });

  it('records a per-genre error without aborting the rest of the run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('type=artist')) {
          const genre = decodeURIComponent(url).match(/genre:"([^"]+)"/)?.[1] ?? '';
          if (genre === GROWTH_GENRES[0]) return new Response('server error', { status: 500 });
          return new Response(JSON.stringify({ artists: { items: [{ id: `${genre}-1`, name: genre, genres: [], images: [{ url: 'https://img/x.jpg' }], popularity: 50 }] } }), { status: 200 });
        }
        if (url.includes('/albums')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
        throw new Error(`unexpected ${url}`);
      })
    );

    const result = await growArtistCatalog(env as any, 1000, { maxInserted: 1 });

    expect(result.errors[GROWTH_GENRES[0]]).toBeTruthy();
    expect(result.inserted).toBe(1); // second genre still succeeded
    vi.unstubAllGlobals();
  });

  it('rotates the starting genre based on now instead of always starting at GROWTH_GENRES[0]', async () => {
    const genresCalled: string[] = [];
    stubArtistSearchByGenre((genre) => {
      genresCalled.push(genre);
      return [{ id: `${genre}-1`, name: genre, genres: [genre], images: [{ url: `https://img/${genre}.jpg` }], popularity: 50 }];
    });

    // Math.floor(20 * 60 * 1000 / (15 * 60 * 1000)) = 1, so the rotation
    // should start at GROWTH_GENRES[1], not GROWTH_GENRES[0].
    const now = 20 * 60 * 1000;
    const result = await growArtistCatalog(env as any, now, { maxInserted: 1 });

    expect(result.inserted).toBe(1);
    expect(genresCalled[0]).toBe(GROWTH_GENRES[1]);
    vi.unstubAllGlobals();
  });
});

import { runCatalogGrowthJob } from '../../src/lib/catalogGrowth';

describe('runCatalogGrowthJob', () => {
  it('does nothing when ARTIST_CATALOG_GROWTH_ENABLED is "false"', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('should not be called');
    });
    vi.stubGlobal('fetch', fetchMock);

    await runCatalogGrowthJob({ ...env, ARTIST_CATALOG_GROWTH_ENABLED: 'false' } as any, 1000);

    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await env.DB.prepare('SELECT * FROM catalog_growth_runs').all();
    expect(rows.results.length).toBe(0);
    vi.unstubAllGlobals();
  });

  it('runs growth and records a successful run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('type=artist')) {
          return new Response(
            JSON.stringify({ artists: { items: [{ id: 'a1', name: 'Fresh', genres: ['pop'], images: [{ url: 'https://img/a1.jpg' }], popularity: 50 }] } }),
            { status: 200 }
          );
        }
        if (url.includes('/albums')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
        throw new Error(`unexpected ${url}`);
      })
    );

    await runCatalogGrowthJob(env as any, 1000);

    const row = await env.DB.prepare('SELECT * FROM catalog_growth_runs').first<any>();
    expect(row.inserted_count).toBe(1);
    expect(row.error).toBeNull();
    expect(JSON.parse(row.genres_tried).length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('records a failed run, emails OPS_ALERT_EMAIL, and rethrows when the job fails outright', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response('invalid client', { status: 401 });
      if (url.includes('api.resend.com')) return new Response('{}', { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runCatalogGrowthJob(env as any, 1000)).rejects.toThrow();

    const row = await env.DB.prepare('SELECT * FROM catalog_growth_runs').first<any>();
    expect(row.inserted_count).toBe(0);
    expect(row.error).toContain('401');
    expect(fetchMock.mock.calls.some((c) => c[0].toString().includes('api.resend.com'))).toBe(true);
    vi.unstubAllGlobals();
  });
});

import { sendCatalogGrowthDigest } from '../../src/lib/catalogGrowth';

describe('sendCatalogGrowthDigest', () => {
  async function insertRun(id: string, createdAt: number, insertedCount: number, error: string | null) {
    await env.DB.prepare(
      `INSERT INTO catalog_growth_runs (id, started_at, finished_at, genres_tried, inserted_count, error, created_at)
       VALUES (?, ?, ?, '[]', ?, ?, ?)`
    ).bind(id, createdAt, createdAt, insertedCount, error, createdAt).run();
  }

  it('aggregates the last 24h of runs into one summary email', async () => {
    const now = 100 * 60 * 60 * 1000; // arbitrary "now" comfortably past 24h from epoch
    await insertRun('r1', now - 1000, 5, null);
    await insertRun('r2', now - 2000, 3, 'boom');
    const fetchMock = vi.fn(async (_input: RequestInfo, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendCatalogGrowthDigest(env as any, now);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.html).toContain('8 new artist(s)');
    expect(body.html).toContain('1 failed run(s)');
    vi.unstubAllGlobals();
  });

  it('excludes runs older than 24h', async () => {
    const now = 100 * 60 * 60 * 1000;
    await insertRun('old', now - 25 * 60 * 60 * 1000, 99, null);
    const fetchMock = vi.fn(async (_input: RequestInfo, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendCatalogGrowthDigest(env as any, now);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.html).toContain('0 new artist(s)');
    vi.unstubAllGlobals();
  });

  it('does nothing when OPS_ALERT_EMAIL is not configured', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendCatalogGrowthDigest({ ...env, OPS_ALERT_EMAIL: undefined } as any, 1000);

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
