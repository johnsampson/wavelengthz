import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { applySchema } from '../apply-schema';
import {
  enrichArtistGenresFromMusicBrainz,
  runHourlyGenreEnrichment,
  processGenreEnrichmentQueueBatch,
  MUSICBRAINZ_CRON_MAX_RUNTIME_MS,
} from '../../src/lib/genreEnrichment';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM artist_genres').run();
  await env.DB.prepare('DELETE FROM artists').run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function insertArtist(id: string, spotifyId: string, genres: Record<string, true> = {}, createdAt = 1000) {
  await env.DB.prepare(
    `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at) VALUES (?, ?, ?, ?, 'seed', 1, ?)`
  )
    .bind(id, spotifyId, id, JSON.stringify(genres), createdAt)
    .run();
}

function stubNoMbidMatch() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ urls: [] }), { status: 200 })));
}

function stubMatchedWithGenres(genres: Array<{ id: string; name: string; count: number }> = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('/ws/2/url/')) {
        return new Response(JSON.stringify({ urls: [{ resource: 'x', 'relation-list': [{ relations: [{ artist: { id: 'mb-1' } }] }] }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ genres }), { status: 200 });
    })
  );
}

async function runEnrichment(options?: { limit?: number; deadline?: number }) {
  vi.useFakeTimers();
  const resultPromise = enrichArtistGenresFromMusicBrainz(env.DB, options);
  await vi.runAllTimersAsync();
  return resultPromise;
}

describe('enrichArtistGenresFromMusicBrainz', () => {
  it('merges MusicBrainz genre names into artists.genres, on top of whatever Spotify already had', async () => {
    await insertArtist('a1', 'sp1', { pop: true });
    stubMatchedWithGenres([{ id: 'g1', name: 'french house', count: 18 }]);

    const result = await runEnrichment();

    expect(result).toEqual({ attempted: 1, matched: 1, noMbidMatch: 0, matchedButNoGenres: 0, failed: 0 });
    const row = await env.DB.prepare('SELECT genres, mbid, genre_enriched_at FROM artists WHERE id = ?').bind('a1').first<any>();
    expect(JSON.parse(row.genres)).toEqual({ pop: true, 'french house': true });
    expect(row.mbid).toBe('mb-1');
    expect(row.genre_enriched_at).not.toBeNull();
  });

  it('stores the full MusicBrainz genre objects (with count) for later use, not just the merged names', async () => {
    await insertArtist('a1', 'sp1');
    stubMatchedWithGenres([
      { id: 'g1', name: 'house', count: 20 },
      { id: 'g2', name: 'techno', count: 1 },
    ]);

    await runEnrichment();

    const rows = await env.DB.prepare('SELECT mb_genre_id, name, count FROM artist_genres WHERE artist_id = ? ORDER BY name').bind('a1').all<any>();
    expect(rows.results).toEqual([
      { mb_genre_id: 'g1', name: 'house', count: 20 },
      { mb_genre_id: 'g2', name: 'techno', count: 1 },
    ]);
  });

  it('gives each artist_genres row its own id, distinct from the (artist_id, mb_genre_id) natural key', async () => {
    await insertArtist('a1', 'sp1');
    stubMatchedWithGenres([{ id: 'g1', name: 'house', count: 20 }]);

    await runEnrichment();

    const row = await env.DB.prepare('SELECT id, updated_at FROM artist_genres WHERE artist_id = ? AND mb_genre_id = ?').bind('a1', 'g1').first<any>();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.updated_at).not.toBeNull();
  });

  it('updates count and updated_at (not a duplicate row) when the same genre tag is seen again on a later run', async () => {
    await insertArtist('a1', 'sp1');
    await env.DB.prepare(
      `INSERT INTO artist_genres (id, artist_id, mb_genre_id, name, count, created_at, updated_at) VALUES ('existing', 'a1', 'g1', 'house', 5, 100, 100)`
    ).run();
    stubMatchedWithGenres([{ id: 'g1', name: 'house', count: 25 }]);

    await runEnrichment();

    const rows = await env.DB.prepare('SELECT id, count FROM artist_genres WHERE artist_id = ?').bind('a1').all<any>();
    expect(rows.results).toEqual([{ id: 'existing', count: 25 }]);
  });

  it('marks genre_enriched_at (but leaves mbid null) when no MusicBrainz link exists, so it is not retried every run', async () => {
    await insertArtist('a1', 'sp1');
    stubNoMbidMatch();

    const result = await runEnrichment();

    expect(result).toEqual({ attempted: 1, matched: 0, noMbidMatch: 1, matchedButNoGenres: 0, failed: 0 });
    const row = await env.DB.prepare('SELECT mbid, genre_enriched_at FROM artists WHERE id = ?').bind('a1').first<any>();
    expect(row.mbid).toBeNull();
    expect(row.genre_enriched_at).not.toBeNull();
  });

  it('counts a matched artist with zero MusicBrainz genre tags separately from a total miss', async () => {
    await insertArtist('a1', 'sp1');
    stubMatchedWithGenres([]);

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
    stubNoMbidMatch();

    const result = await runEnrichment({ limit: 1 });

    expect(result.attempted).toBe(1);
    const remaining = await env.DB.prepare('SELECT COUNT(*) as c FROM artists WHERE genre_enriched_at IS NULL').first<{ c: number }>();
    expect(remaining!.c).toBe(1);
  });

  it('processes the longest-waiting (oldest created_at) artists first, so a freshly-added artist is not starved behind an older backlog', async () => {
    await insertArtist('newer', 'sp-new', {}, 5000);
    await insertArtist('older', 'sp-old', {}, 1000);
    stubNoMbidMatch();

    await runEnrichment({ limit: 1 });

    const older = await env.DB.prepare('SELECT genre_enriched_at FROM artists WHERE id = ?').bind('older').first<any>();
    const newer = await env.DB.prepare('SELECT genre_enriched_at FROM artists WHERE id = ?').bind('newer').first<any>();
    expect(older.genre_enriched_at).not.toBeNull();
    expect(newer.genre_enriched_at).toBeNull();
  });

  it('stops starting new artists once the deadline has passed, but always finishes an artist already in flight', async () => {
    await insertArtist('a1', 'sp1');
    await insertArtist('a2', 'sp2');
    stubNoMbidMatch();

    vi.useFakeTimers();
    const start = Date.now();
    // Shorter than even one artist's two-call round trip (2 * 1250ms) --
    // the first artist must still run to completion before the deadline
    // check for a *second* artist stops the loop.
    const resultPromise = enrichArtistGenresFromMusicBrainz(env.DB, { deadline: start + 1000 });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.attempted).toBe(1);
    const remaining = await env.DB.prepare('SELECT COUNT(*) as c FROM artists WHERE genre_enriched_at IS NULL').first<{ c: number }>();
    expect(remaining!.c).toBe(1);
  });

  it('waits at least the rate-limit delay between MusicBrainz calls', async () => {
    await insertArtist('a1', 'sp1');
    stubMatchedWithGenres([]);

    vi.useFakeTimers();
    const resultPromise = enrichArtistGenresFromMusicBrainz(env.DB, { limit: 1 });
    // Only enough time for the first call's delay, not the second -- the
    // function must still be awaiting the second sleep at this point.
    await vi.advanceTimersByTimeAsync(1250);
    let settled = false;
    resultPromise.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1250);
    await resultPromise;
  });
});

describe('runHourlyGenreEnrichment', () => {
  beforeEach(async () => {
    await env.RATE_LIMIT_KV.delete('musicbrainz-enrichment-lock');
  });

  it('acquires and releases the lock around a normal run', async () => {
    await insertArtist('a1', 'sp1');
    stubNoMbidMatch();

    vi.useFakeTimers();
    const resultPromise = runHourlyGenreEnrichment(env.DB, env.RATE_LIMIT_KV);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ attempted: 1, matched: 0, noMbidMatch: 1, matchedButNoGenres: 0, failed: 0 });
    expect(await env.RATE_LIMIT_KV.get('musicbrainz-enrichment-lock')).toBeNull();
  });

  it('skips the run entirely when a previous run has not released the lock yet', async () => {
    await env.RATE_LIMIT_KV.put('musicbrainz-enrichment-lock', '1', { expirationTtl: 3600 });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runHourlyGenreEnrichment(env.DB, env.RATE_LIMIT_KV);

    expect(result).toEqual({ skipped: true, reason: 'already_running' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses a deadline comfortably under the full hour, leaving a buffer before the next cron tick', () => {
    expect(MUSICBRAINZ_CRON_MAX_RUNTIME_MS).toBeLessThan(60 * 60 * 1000);
  });
});

describe('processGenreEnrichmentQueueBatch', () => {
  function fakeBatch(artistIds: string[]) {
    const acked: string[] = [];
    const retried: string[] = [];
    const messages = artistIds.map((artistId, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      body: { artistId },
      attempts: 1,
      ack: () => acked.push(artistId),
      retry: () => retried.push(artistId),
    }));
    return { batch: { messages, queue: 'musicbrainz-genre-enrichment', metadata: {} as any, retryAll: () => {}, ackAll: () => {} }, acked, retried };
  }

  it('enriches the artist named in the message and acks it on success', async () => {
    await insertArtist('a1', 'sp1');
    stubMatchedWithGenres([{ id: 'g1', name: 'house', count: 5 }]);
    const { batch, acked } = fakeBatch(['a1']);

    vi.useFakeTimers();
    const donePromise = processGenreEnrichmentQueueBatch(batch as any, env.DB);
    await vi.runAllTimersAsync();
    await donePromise;

    expect(acked).toEqual(['a1']);
    const row = await env.DB.prepare('SELECT mbid FROM artists WHERE id = ?').bind('a1').first<any>();
    expect(row.mbid).toBe('mb-1');
  });

  it('retries the message (not the whole batch) on a failed lookup', async () => {
    await insertArtist('a1', 'sp1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 503 })));
    const { batch, acked, retried } = fakeBatch(['a1']);

    vi.useFakeTimers();
    const donePromise = processGenreEnrichmentQueueBatch(batch as any, env.DB);
    await vi.runAllTimersAsync();
    await donePromise;

    expect(retried).toEqual(['a1']);
    expect(acked).toEqual([]);
  });

  it('acks immediately, with no MusicBrainz call, when the artist was already enriched (e.g. the hourly sweep won the race)', async () => {
    await insertArtist('a1', 'sp1');
    await env.DB.prepare('UPDATE artists SET genre_enriched_at = ? WHERE id = ?').bind(999, 'a1').run();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { batch, acked } = fakeBatch(['a1']);

    await processGenreEnrichmentQueueBatch(batch as any, env.DB);

    expect(acked).toEqual(['a1']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('processes multiple messages in one batch sequentially, never concurrently', async () => {
    await insertArtist('a1', 'sp1');
    await insertArtist('a2', 'sp2');
    let inFlight = 0;
    let maxConcurrent = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        const res = new Response(JSON.stringify({ urls: [] }), { status: 200 });
        inFlight--;
        return res;
      })
    );
    const { batch } = fakeBatch(['a1', 'a2']);

    vi.useFakeTimers();
    const donePromise = processGenreEnrichmentQueueBatch(batch as any, env.DB);
    await vi.runAllTimersAsync();
    await donePromise;

    expect(maxConcurrent).toBe(1);
  });
});
