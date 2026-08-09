import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { enrichArtistGenresFromMusicBrainz } from '../../src/lib/genreEnrichment';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM artist_musicbrainz_genres').run();
  await env.DB.prepare('DELETE FROM artists').run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function insertArtist(id: string, spotifyId: string, genres: Record<string, true> = {}) {
  await env.DB.prepare(
    `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at) VALUES (?, ?, ?, ?, 'seed', 1, 1000)`
  )
    .bind(id, spotifyId, id, JSON.stringify(genres))
    .run();
}

async function runEnrichment(limit?: number) {
  vi.useFakeTimers();
  const resultPromise = enrichArtistGenresFromMusicBrainz(env.DB, limit);
  await vi.runAllTimersAsync();
  return resultPromise;
}

describe('enrichArtistGenresFromMusicBrainz', () => {
  it('merges MusicBrainz genre names into artists.genres, on top of whatever Spotify already had', async () => {
    await insertArtist('a1', 'sp1', { pop: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/ws/2/url/')) {
          return new Response(JSON.stringify({ urls: [{ resource: 'x', 'relation-list': [{ relations: [{ artist: { id: 'mb-1' } }] }] }] }), {
            status: 200,
          });
        }
        if (url.includes('/ws/2/artist/mb-1')) {
          return new Response(JSON.stringify({ genres: [{ id: 'g1', name: 'french house', count: 18 }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    const result = await runEnrichment();

    expect(result).toEqual({ attempted: 1, matched: 1, noMbidMatch: 0, matchedButNoGenres: 0, failed: 0 });
    const row = await env.DB.prepare('SELECT genres, mbid, genre_enriched_at FROM artists WHERE id = ?').bind('a1').first<any>();
    expect(JSON.parse(row.genres)).toEqual({ pop: true, 'french house': true });
    expect(row.mbid).toBe('mb-1');
    expect(row.genre_enriched_at).not.toBeNull();
  });

  it('stores the full MusicBrainz genre objects (with count) for later use, not just the merged names', async () => {
    await insertArtist('a1', 'sp1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/ws/2/url/')) {
          return new Response(JSON.stringify({ urls: [{ resource: 'x', 'relation-list': [{ relations: [{ artist: { id: 'mb-1' } }] }] }] }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            genres: [
              { id: 'g1', name: 'house', count: 20 },
              { id: 'g2', name: 'techno', count: 1 },
            ],
          }),
          { status: 200 }
        );
      })
    );

    await runEnrichment();

    const rows = await env.DB.prepare('SELECT mb_genre_id, name, count FROM artist_musicbrainz_genres WHERE artist_id = ? ORDER BY name').bind('a1').all<any>();
    expect(rows.results).toEqual([
      { mb_genre_id: 'g1', name: 'house', count: 20 },
      { mb_genre_id: 'g2', name: 'techno', count: 1 },
    ]);
  });

  it('marks genre_enriched_at (but leaves mbid null) when no MusicBrainz link exists, so it is not retried every run', async () => {
    await insertArtist('a1', 'sp1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ urls: [] }), { status: 200 })));

    const result = await runEnrichment();

    expect(result).toEqual({ attempted: 1, matched: 0, noMbidMatch: 1, matchedButNoGenres: 0, failed: 0 });
    const row = await env.DB.prepare('SELECT mbid, genre_enriched_at FROM artists WHERE id = ?').bind('a1').first<any>();
    expect(row.mbid).toBeNull();
    expect(row.genre_enriched_at).not.toBeNull();
  });

  it('counts a matched artist with zero MusicBrainz genre tags separately from a total miss', async () => {
    await insertArtist('a1', 'sp1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/ws/2/url/')) {
          return new Response(JSON.stringify({ urls: [{ resource: 'x', 'relation-list': [{ relations: [{ artist: { id: 'mb-1' } }] }] }] }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ genres: [] }), { status: 200 });
      })
    );

    const result = await runEnrichment();

    expect(result).toEqual({ attempted: 1, matched: 1, noMbidMatch: 0, matchedButNoGenres: 1, failed: 0 });
  });

  it('leaves genre_enriched_at unset on a failed lookup, so it gets retried rather than treated as a confirmed no-match', async () => {
    await insertArtist('a1', 'sp1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 503 })));

    const result = await runEnrichment();

    expect(result).toEqual({ attempted: 1, matched: 0, noMbidMatch: 0, matchedButNoGenres: 0, failed: 1 });
    const row = await env.DB.prepare('SELECT genre_enriched_at FROM artists WHERE id = ?').bind('a1').first<any>();
    expect(row.genre_enriched_at).toBeNull();
  });

  it('never re-processes an artist that already has genre_enriched_at set', async () => {
    await insertArtist('a1', 'sp1');
    await env.DB.prepare('UPDATE artists SET genre_enriched_at = ? WHERE id = ?').bind(999, 'a1').run();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ urls: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runEnrichment();

    expect(result.attempted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('respects the requested batch limit, leaving the rest for a future run', async () => {
    await insertArtist('a1', 'sp1');
    await insertArtist('a2', 'sp2');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ urls: [] }), { status: 200 })));

    const result = await runEnrichment(1);

    expect(result.attempted).toBe(1);
    const remaining = await env.DB.prepare('SELECT COUNT(*) as c FROM artists WHERE genre_enriched_at IS NULL').first<{ c: number }>();
    expect(remaining!.c).toBe(1);
  });

  it('waits at least the rate-limit delay between MusicBrainz calls', async () => {
    await insertArtist('a1', 'sp1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/ws/2/url/')) {
          return new Response(JSON.stringify({ urls: [{ resource: 'x', 'relation-list': [{ relations: [{ artist: { id: 'mb-1' } }] }] }] }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ genres: [] }), { status: 200 });
      })
    );

    vi.useFakeTimers();
    const resultPromise = enrichArtistGenresFromMusicBrainz(env.DB, 1);
    // Only enough time for the first call's delay, not the second -- the
    // function must still be awaiting the second sleep at this point.
    await vi.advanceTimersByTimeAsync(1100);
    let settled = false;
    resultPromise.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1100);
    await resultPromise;
  });
});
