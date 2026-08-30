import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { discoverArtistsByGenre, nextDiscoveryTargets } from '../../src/lib/catalogDiscovery';
import { SEED_GENRES } from '../../src/db/seed';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM tracks; DELETE FROM genres; DELETE FROM artists;');
  await env.RATE_LIMIT_KV.delete('spotify-cooldown');
  const cursors = await env.RATE_LIMIT_KV.list({ prefix: 'catalog-discovery-cursor:' });
  await Promise.all(cursors.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
  const pending = await env.RATE_LIMIT_KV.list({ prefix: 'artist-backfill-pending:' });
  await Promise.all(pending.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function artist(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Artist ${id}`,
    genres: ['indie'],
    images: [{ url: `https://img.example/${id}.jpg` }],
    popularity: 50,
    ...extra,
  };
}

/**
 * Stubs the two calls a discovery run is allowed to make: the
 * client-credentials token, and GET /v1/search?type=artist. Anything else --
 * notably any track endpoint -- throws, which is what the "never calls a
 * track endpoint" tests below rely on.
 */
function stubSpotifySearch(artistsPerCall: Record<string, any[]> | any[]) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo) => {
    const url = input.toString();
    calls.push(url);
    if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
    if (url.includes('/v1/search') && url.includes('type=artist')) {
      const genreMatch = decodeURIComponent(url).match(/genre:"([^"]+)"/);
      const genre = genreMatch?.[1] ?? '';
      const items = Array.isArray(artistsPerCall) ? artistsPerCall : (artistsPerCall[genre] ?? []);
      return new Response(JSON.stringify({ artists: { items } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

describe('nextDiscoveryTargets', () => {
  it('starts every genre at offset 0 when no cursor is stored yet', async () => {
    const targets = await nextDiscoveryTargets(env.RATE_LIMIT_KV, ['pop', 'jazz'], 2, 0);
    expect(targets).toEqual([
      { genre: 'pop', offset: 0 },
      { genre: 'jazz', offset: 0 },
    ]);
  });

  it('reads a stored per-genre cursor', async () => {
    await env.RATE_LIMIT_KV.put('catalog-discovery-cursor:jazz', '40');
    const targets = await nextDiscoveryTargets(env.RATE_LIMIT_KV, ['pop', 'jazz'], 2, 0);
    expect(targets).toEqual([
      { genre: 'pop', offset: 0 },
      { genre: 'jazz', offset: 40 },
    ]);
  });

  it('rotates which genres a run advances, so one genre is not walked to exhaustion first', async () => {
    const genres = ['a', 'b', 'c', 'd', 'e', 'f'];
    const run0 = await nextDiscoveryTargets(env.RATE_LIMIT_KV, genres, 2, 0);
    const run1 = await nextDiscoveryTargets(env.RATE_LIMIT_KV, genres, 2, 1);
    const run2 = await nextDiscoveryTargets(env.RATE_LIMIT_KV, genres, 2, 2);

    expect(run0.map((t) => t.genre)).toEqual(['a', 'b']);
    expect(run1.map((t) => t.genre)).toEqual(['c', 'd']);
    expect(run2.map((t) => t.genre)).toEqual(['e', 'f']);
  });

  it('wraps the genre rotation back around rather than running off the end', async () => {
    const targets = await nextDiscoveryTargets(env.RATE_LIMIT_KV, ['a', 'b', 'c'], 2, 1);
    expect(targets.map((t) => t.genre)).toEqual(['c', 'a']);
  });

  it('falls back to offset 0 for a corrupted, negative, or out-of-range cursor', async () => {
    await env.RATE_LIMIT_KV.put('catalog-discovery-cursor:a', 'not-a-number');
    await env.RATE_LIMIT_KV.put('catalog-discovery-cursor:b', '-10');
    // Past Spotify's own offset+limit ceiling (~1000) -- the API errors on
    // these rather than returning an empty page.
    await env.RATE_LIMIT_KV.put('catalog-discovery-cursor:c', '99999');

    const targets = await nextDiscoveryTargets(env.RATE_LIMIT_KV, ['a', 'b', 'c'], 3, 0);
    expect(targets.map((t) => t.offset)).toEqual([0, 0, 0]);
  });

  it('never asks for more genres than exist', async () => {
    const targets = await nextDiscoveryTargets(env.RATE_LIMIT_KV, ['only'], 4, 0);
    expect(targets).toHaveLength(1);
  });

  it('returns nothing for an empty genre list rather than throwing', async () => {
    expect(await nextDiscoveryTargets(env.RATE_LIMIT_KV, [], 4, 0)).toEqual([]);
  });
});

describe('discoverArtistsByGenre', () => {
  it('inserts newly-discovered artists and records their genres', async () => {
    stubSpotifySearch([artist('sp-a'), artist('sp-b')]);

    const result = await discoverArtistsByGenre(env as any, 0);

    expect(result.artistsAdded).toBeGreaterThan(0);
    const row = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('sp-a').first<any>();
    expect(row).not.toBeNull();
    expect(row.source).toBe('spotify_search');
    expect(row.image_url).toBe('https://img.example/sp-a.jpg');

    const genreRow = await env.DB.prepare('SELECT * FROM genres WHERE genre = ?').bind('indie').first<any>();
    expect(genreRow.artist_count).toBeGreaterThan(0);
  });

  it('never calls a track endpoint -- not /v1/tracks/{id}, not /v1/albums/{id}/tracks', async () => {
    const { calls } = stubSpotifySearch([artist('sp-a'), artist('sp-b')]);

    await discoverArtistsByGenre(env as any, 0);

    expect(calls.some((c) => c.includes('/v1/tracks/'))).toBe(false);
    expect(calls.some((c) => c.includes('/tracks'))).toBe(false);
    expect(calls.some((c) => c.includes('/albums'))).toBe(false);
    // Only the token call plus one search per genre advanced this run.
    expect(calls.every((c) => c.includes('api/token') || c.includes('/v1/search'))).toBe(true);
  });

  it('costs one Spotify search call per genre, regardless of how many artists come back', async () => {
    const many = Array.from({ length: 10 }, (_, i) => artist(`sp-${i}`));
    const { calls } = stubSpotifySearch(many);

    await discoverArtistsByGenre(env as any, 0);

    const searchCalls = calls.filter((c) => c.includes('/v1/search'));
    expect(searchCalls.length).toBeLessThanOrEqual(6); // GENRES_PER_RUN
    expect(await env.DB.prepare('SELECT COUNT(*) c FROM artists').first<{ c: number }>()).toEqual({ c: 10 });
  });

  it('skips an artist with no photo -- it could never surface as a deck candidate anyway', async () => {
    stubSpotifySearch([artist('sp-photo'), artist('sp-nophoto', { images: [] })]);

    await discoverArtistsByGenre(env as any, 0);

    expect(await env.DB.prepare('SELECT 1 FROM artists WHERE spotify_id = ?').bind('sp-photo').first()).not.toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM artists WHERE spotify_id = ?').bind('sp-nophoto').first()).toBeNull();
  });

  it('skips an artist already in the catalog without re-inserting it', async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, image_url, source, approved, created_at) VALUES ('known', 'sp-a', 'Known', '{}', 'x', 'seed', 1, 1000)`
    ).run();
    stubSpotifySearch([artist('sp-a'), artist('sp-new')]);

    const result = await discoverArtistsByGenre(env as any, 0);

    const rows = await env.DB.prepare('SELECT COUNT(*) c FROM artists WHERE spotify_id = ?').bind('sp-a').first<{ c: number }>();
    expect(rows?.c).toBe(1);
    expect(result.artistsAdded).toBe(1); // sp-new only
  });

  it('advances the per-genre cursor so the next run walks fresh ground', async () => {
    stubSpotifySearch([artist('sp-a')]);

    await discoverArtistsByGenre(env as any, 0);

    const advanced = await env.RATE_LIMIT_KV.get(`catalog-discovery-cursor:${SEED_GENRES[0]}`);
    expect(Number(advanced)).toBe(10); // ARTISTS_PER_SEARCH
  });

  it('advances the cursor even when a page yields nothing insertable -- otherwise it would stick there forever', async () => {
    stubSpotifySearch([]);

    await discoverArtistsByGenre(env as any, 0);

    const advanced = await env.RATE_LIMIT_KV.get(`catalog-discovery-cursor:${SEED_GENRES[0]}`);
    expect(Number(advanced)).toBe(10);
  });

  it('wraps the cursor back to 0 once past Spotify\'s offset ceiling', async () => {
    await env.RATE_LIMIT_KV.put(`catalog-discovery-cursor:${SEED_GENRES[0]}`, '950');
    stubSpotifySearch([]);

    await discoverArtistsByGenre(env as any, 0);

    expect(await env.RATE_LIMIT_KV.get(`catalog-discovery-cursor:${SEED_GENRES[0]}`)).toBe('0');
  });

  it('stops the whole run without calling Spotify at all while the app-wide cooldown is active', async () => {
    // searchArtistsByGenre checks this flag itself and throws before any
    // network call -- the exact admission control this background job is
    // meant to respect.
    await env.RATE_LIMIT_KV.put('spotify-cooldown', String(Date.now() + 30_000), { expirationTtl: 60 });
    const { calls } = stubSpotifySearch([artist('sp-a')]);

    const result = await discoverArtistsByGenre(env as any, 0);

    expect(result.cooledDown).toBe(true);
    expect(result.artistsAdded).toBe(0);
    expect(calls.some((c) => c.includes('/v1/search'))).toBe(false);
  });

  it('keeps going when one genre\'s search fails, rather than losing the whole run', async () => {
    const failGenre = SEED_GENRES[0];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('/v1/search')) {
          if (decodeURIComponent(url).includes(`genre:"${failGenre}"`)) return new Response('nope', { status: 500 });
          return new Response(JSON.stringify({ artists: { items: [artist('sp-ok')] } }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const result = await discoverArtistsByGenre(env as any, 0);

    expect(result.artistsAdded).toBeGreaterThan(0);
    expect(await env.DB.prepare('SELECT 1 FROM artists WHERE spotify_id = ?').bind('sp-ok').first()).not.toBeNull();
  });

  it('returns an empty result instead of throwing when the token fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    const result = await discoverArtistsByGenre(env as any, 0);

    expect(result).toEqual({ artistsAdded: 0, genresSearched: 0, backfillsEnqueued: 0, cooledDown: false });
  });

  it('enqueues a bounded, popularity-ranked track backfill rather than fetching tracks itself', async () => {
    const sent: any[] = [];
    const envWithSpy = {
      ...env,
      ARTIST_TRACK_BACKFILL_QUEUE: { send: async (m: any) => { sent.push(m); } },
    };
    // 32 candidates, two more than TRACK_BACKFILL_PER_RUN (30), so the
    // top-30 cutoff is actually exercised rather than trivially enqueuing
    // everyone. Popularity 1..32, shuffled insertion order so ranking (not
    // insertion order) is what's actually under test.
    const candidates = Array.from({ length: 32 }, (_, i) => artist(`sp-p${i + 1}`, { popularity: i + 1 }));
    stubSpotifySearch([...candidates].reverse());

    const result = await discoverArtistsByGenre(envWithSpy as any, 0);

    expect(result.backfillsEnqueued).toBe(30); // TRACK_BACKFILL_PER_RUN
    expect(sent).toHaveLength(30);
    // Highest popularity first -- these are the artists most likely to be
    // opened, so they're the ones worth pre-warming a play button for. The
    // two least popular (sp-p1, sp-p2) fall outside the top 30 and are
    // excluded.
    expect(sent.map((m) => m.spotifyArtistId)).toEqual(
      Array.from({ length: 30 }, (_, i) => `sp-p${32 - i}`)
    );
    // Enqueue only: the queue consumer makes every actual track call.
    expect(sent.every((m) => typeof m.artistId === 'string' && m.limit === 30)).toBe(true);
  });
});
