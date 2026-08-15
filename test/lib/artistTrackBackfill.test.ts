import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { applySchema } from '../apply-schema';
import {
  processArtistTrackBackfillBatch,
  enqueueArtistTrackBackfill,
  type ArtistTrackBackfillMessage,
} from '../../src/lib/artistTrackBackfill';
import { readArtistTracksCache } from '../../src/lib/artistTracksCache';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM tracks; DELETE FROM genres; DELETE FROM artists;');
  await env.RATE_LIMIT_KV.delete('spotify-cooldown');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function insertArtist(id: string, spotifyId: string, genres: Record<string, true> = {}) {
  await env.DB.prepare(`INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at) VALUES (?, ?, ?, ?, 'seed', 1, 1000)`)
    .bind(id, spotifyId, id, JSON.stringify(genres))
    .run();
}

function stubSpotify(tracks: Array<{ id: string; name: string }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      if (url.includes('/artists/') && url.includes('/albums')) {
        return new Response(JSON.stringify({ items: tracks.length > 0 ? [{ id: 'album-1', images: [] }] : [] }), { status: 200 });
      }
      if (url.includes('/albums/album-1/tracks')) {
        // No separate per-track detail fetch -- the album-tracks response
        // already carries everything fetchArtistTracks needs (name,
        // preview_url, artists); see spotify.ts's fetchAlbumTracks.
        return new Response(
          JSON.stringify({ items: tracks.map((t) => ({ id: t.id, name: t.name, preview_url: null, artists: [{ id: 'sp1' }] })) }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected ${url}`);
    })
  );
}

function fakeBatch(messages: ArtistTrackBackfillMessage[]) {
  const acked: ArtistTrackBackfillMessage[] = [];
  const retried: ArtistTrackBackfillMessage[] = [];
  const retryOptions: Array<{ delaySeconds?: number } | undefined> = [];
  const batchMessages = messages.map((body, i) => ({
    id: `m${i}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: () => acked.push(body),
    retry: (options?: { delaySeconds?: number }) => {
      retried.push(body);
      retryOptions.push(options);
    },
  }));
  return {
    batch: { messages: batchMessages, queue: 'artist-track-backfill', metadata: {} as any, retryAll: () => {}, ackAll: () => {} },
    acked,
    retried,
    retryOptions,
  };
}

describe('processArtistTrackBackfillBatch', () => {
  it('fetches the full track list, upserts every track, writes the cache, and acks the message', async () => {
    await insertArtist('a1', 'sp1', { indie: true });
    stubSpotify([{ id: 't1', name: 'Track One' }, { id: 't2', name: 'Track Two' }]);
    const { batch, acked } = fakeBatch([{ artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 }]);

    await processArtistTrackBackfillBatch(batch as any, env as any);

    expect(acked).toHaveLength(1);
    const rows = await env.DB.prepare('SELECT spotify_id FROM tracks WHERE artist_id = ?').bind('a1').all<any>();
    expect(rows.results.map((r: any) => r.spotify_id).sort()).toEqual(['t1', 't2']);

    const cached = await readArtistTracksCache(env.RATE_LIMIT_KV, 'sp1', 30);
    expect(cached?.map((t: any) => t.id)).toEqual(['t1', 't2']);
  });

  it('logs a spotify_call_context marker for this artist before its Spotify calls, so a live log tail can attribute the burst to this queue job', async () => {
    await insertArtist('a1', 'sp1', { indie: true });
    stubSpotify([{ id: 't1', name: 'Track One' }]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { batch } = fakeBatch([{ artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 }]);

    await processArtistTrackBackfillBatch(batch as any, env as any);

    const marker = logSpy.mock.calls.find(([entry]) => entry?.type === 'spotify_call_context');
    expect(marker).toBeDefined();
    expect(marker![0]).toEqual({
      type: 'spotify_call_context',
      context: 'artist-track-backfill',
      spotifyArtistId: 'sp1',
    });
    // The marker must actually precede this artist's Spotify calls (not just
    // exist somewhere in the log), so a human reading a live tail sees it
    // immediately above the burst it explains.
    const markerIndex = logSpy.mock.calls.findIndex(([entry]) => entry?.type === 'spotify_call_context');
    const firstCallIndex = logSpy.mock.calls.findIndex(([entry]) => entry?.type === 'spotify_call');
    expect(markerIndex).toBeLessThan(firstCallIndex);
    logSpy.mockRestore();
  });

  it('records the artist\'s own genres against each newly-inserted track', async () => {
    await insertArtist('a1', 'sp1', { indie: true, rock: true });
    stubSpotify([{ id: 't1', name: 'Track One' }]);
    const { batch } = fakeBatch([{ artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 }]);

    await processArtistTrackBackfillBatch(batch as any, env as any);

    const genreRow = await env.DB.prepare('SELECT track_count FROM genres WHERE genre = ?').bind('indie').first<any>();
    expect(genreRow.track_count).toBe(1);
  });

  it('does not double-count genres when the track was already upserted (e.g. by the quick path)', async () => {
    await insertArtist('a1', 'sp1', { indie: true });
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, source, approved, created_at, updated_at) VALUES ('existing', 't1', 'Track One', 'a1', 'spotify_search', 1, 1000, 1000)`
    ).run();
    stubSpotify([{ id: 't1', name: 'Track One' }]);
    const { batch } = fakeBatch([{ artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 }]);

    await processArtistTrackBackfillBatch(batch as any, env as any);

    const rows = await env.DB.prepare('SELECT id FROM tracks WHERE spotify_id = ?').bind('t1').all<any>();
    expect(rows.results).toHaveLength(1); // still just the one row, not duplicated
    expect(rows.results[0].id).toBe('existing'); // upsertTrack found and reused it
  });

  it('acks immediately, with no Spotify call, when the artist no longer exists', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { batch, acked } = fakeBatch([{ artistId: 'missing-artist', spotifyArtistId: 'sp1', limit: 30 }]);

    await processArtistTrackBackfillBatch(batch as any, env as any);

    expect(acked).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('retries the message (not the whole batch) when the Spotify fetch fails', async () => {
    await insertArtist('a1', 'sp1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));
    const { batch, acked, retried } = fakeBatch([{ artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 }]);

    await processArtistTrackBackfillBatch(batch as any, env as any);

    expect(retried).toHaveLength(1);
    expect(acked).toHaveLength(0);
  });

  it('processes multiple messages in one batch independently -- one failure does not block the others', async () => {
    await insertArtist('a1', 'sp1');
    await insertArtist('a2', 'sp2');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('sp1') && url.includes('/albums')) return new Response('server error', { status: 500 });
        if (url.includes('/artists/') && url.includes('/albums')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
        throw new Error(`unexpected ${url}`);
      })
    );
    const { batch, acked, retried } = fakeBatch([
      { artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 },
      { artistId: 'a2', spotifyArtistId: 'sp2', limit: 30 },
    ]);

    await processArtistTrackBackfillBatch(batch as any, env as any);

    expect(retried).toEqual([{ artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 }]);
    expect(acked).toEqual([{ artistId: 'a2', spotifyArtistId: 'sp2', limit: 30 }]);
  });

  it('retries with a delay matching the remaining cooldown, and makes no Spotify call, when an active cooldown is in effect', async () => {
    await insertArtist('a1', 'sp1');
    const fetchSpy = vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);
    await env.RATE_LIMIT_KV.put('spotify-cooldown', String(Date.now() + 10000));
    const { batch, acked, retried, retryOptions } = fakeBatch([{ artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 }]);

    await processArtistTrackBackfillBatch(batch as any, env as any);

    expect(acked).toHaveLength(0);
    expect(retried).toHaveLength(1);
    expect(retryOptions[0]?.delaySeconds).toBeGreaterThan(0);
    expect(retryOptions[0]?.delaySeconds).toBeLessThanOrEqual(10);
    // Only the client-credentials token call happened -- no artist-albums
    // fetch at all, since the cooldown check short-circuits before it.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('still processes normally when there is no active cooldown', async () => {
    await insertArtist('a1', 'sp1');
    stubSpotify([{ id: 't1', name: 'Track One' }]);
    const { batch, acked } = fakeBatch([{ artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 }]);

    await processArtistTrackBackfillBatch(batch as any, env as any);

    expect(acked).toHaveLength(1);
  });
});

describe('enqueueArtistTrackBackfill', () => {
  beforeEach(async () => {
    // No dedicated `beforeEach` KV reset in this file's other describe block
    // relies on cloudflare:test's isolated-storage-per-test default; this
    // one's assertions are about that same KV, so it's worth stating
    // explicitly rather than leaning on an implicit default.
    const keys = await env.RATE_LIMIT_KV.list();
    await Promise.all(keys.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
  });

  it('sends the message to the queue and sets the pending lock', async () => {
    const message: ArtistTrackBackfillMessage = { artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 };

    await enqueueArtistTrackBackfill(env as any, message);

    const pending = await env.RATE_LIMIT_KV.get('artist-backfill-pending:sp1');
    expect(pending).not.toBeNull();
  });

  it('does not enqueue a second time while a backfill for the same artist is already pending', async () => {
    const message: ArtistTrackBackfillMessage = { artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 };
    const sendSpy = vi.spyOn(env.ARTIST_TRACK_BACKFILL_QUEUE, 'send');

    await enqueueArtistTrackBackfill(env as any, message);
    await enqueueArtistTrackBackfill(env as any, message);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    sendSpy.mockRestore();
  });

  it('enqueues independently for different artists', async () => {
    const sendSpy = vi.spyOn(env.ARTIST_TRACK_BACKFILL_QUEUE, 'send');

    await enqueueArtistTrackBackfill(env as any, { artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 });
    await enqueueArtistTrackBackfill(env as any, { artistId: 'a2', spotifyArtistId: 'sp2', limit: 30 });

    expect(sendSpy).toHaveBeenCalledTimes(2);
    sendSpy.mockRestore();
  });

  it('does not set the pending lock when the queue send itself fails, so a later attempt can retry', async () => {
    const brokenEnv = {
      ...env,
      ARTIST_TRACK_BACKFILL_QUEUE: {
        send: async () => {
          throw new Error('queue unavailable');
        },
      },
    } as any;

    await enqueueArtistTrackBackfill(brokenEnv, { artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 });

    const pending = await env.RATE_LIMIT_KV.get('artist-backfill-pending:sp1');
    expect(pending).toBeNull();
  });

  it('still attempts the enqueue (fails open) when the pending-lock KV read itself fails', async () => {
    const brokenEnv = {
      ...env,
      RATE_LIMIT_KV: {
        ...env.RATE_LIMIT_KV,
        get: async () => {
          throw new Error('KV unavailable');
        },
      },
    } as any;
    const sendSpy = vi.spyOn(env.ARTIST_TRACK_BACKFILL_QUEUE, 'send');

    await enqueueArtistTrackBackfill(brokenEnv, { artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    sendSpy.mockRestore();
  });
});
