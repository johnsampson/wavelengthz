import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { seedCatalog, SEED_GENRES } from '../../src/db/seed';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM tracks; DELETE FROM artists;');
});

describe('seedCatalog', () => {
  it('inserts artists and tracks across the seed genre list, deduped by id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('/v1/search')) {
          // every genre search returns the SAME artist id to exercise dedup
          return new Response(
            JSON.stringify({
              artists: {
                items: [
                  { id: 'artist-1', name: 'Shared Artist', genres: ['pop'], images: [{ url: 'http://img/a' }], popularity: 80 },
                ],
              },
            }),
            { status: 200 }
          );
        }
        if (url.includes('/top-tracks')) {
          return new Response(
            JSON.stringify({
              tracks: [
                { id: 'track-1', name: 'Song One', album: { images: [{ url: 'http://img/t1' }] }, preview_url: 'http://preview/1' },
                { id: 'track-2', name: 'Song Two', album: { images: [{ url: 'http://img/t2' }] }, preview_url: null },
              ],
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const result = await seedCatalog(env as any);

    expect(result.artistsInserted).toBe(1); // deduped across all SEED_GENRES
    expect(result.tracksInserted).toBe(2);

    const artist = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind('artist-1').first<any>();
    expect(artist.source).toBe('seed');
    expect(artist.approved).toBe(1);
    expect(artist.added_by_user_id).toBeNull();

    const trackCount = await env.DB.prepare('SELECT COUNT(*) as c FROM tracks WHERE artist_id = ?').bind('artist-1').first<any>();
    expect(trackCount.c).toBe(2);

    expect(result.failedArtistIds).toEqual([]);

    vi.unstubAllGlobals();
  });

  it('exposes a genre list of at least 10 genres', () => {
    expect(SEED_GENRES.length).toBeGreaterThanOrEqual(10);
  });

  it('skips an artist whose top-tracks fetch fails, without aborting the rest of the run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('/v1/search')) {
          // every genre search returns the SAME two artists, to keep this test genre-count-independent
          return new Response(
            JSON.stringify({
              artists: {
                items: [
                  { id: 'artist-ok', name: 'Reliable Artist', genres: ['pop'], images: [{ url: 'http://img/ok' }], popularity: 70 },
                  { id: 'artist-fail', name: 'Flaky Artist', genres: ['pop'], images: [{ url: 'http://img/fail' }], popularity: 60 },
                ],
              },
            }),
            { status: 200 }
          );
        }
        if (url.includes('/artists/artist-fail/top-tracks')) {
          // simulate a transient upstream failure (e.g. 500/429) for this one artist
          return new Response('server error', { status: 500 });
        }
        if (url.includes('/top-tracks')) {
          return new Response(
            JSON.stringify({
              tracks: [
                { id: 'track-1', name: 'Song One', album: { images: [{ url: 'http://img/t1' }] }, preview_url: 'http://preview/1' },
                { id: 'track-2', name: 'Song Two', album: { images: [{ url: 'http://img/t2' }] }, preview_url: null },
              ],
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const result = await seedCatalog(env as any);

    // Both artists get inserted (the artist insert happens before the top-tracks
    // fetch that fails for artist-fail); only artist-ok's tracks land.
    expect(result.artistsInserted).toBe(2);
    expect(result.tracksInserted).toBe(2);
    expect(result.failedArtistIds).toEqual(['artist-fail']);

    const failedArtist = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind('artist-fail').first<any>();
    expect(failedArtist).not.toBeNull();

    const failedArtistTrackCount = await env.DB.prepare('SELECT COUNT(*) as c FROM tracks WHERE artist_id = ?')
      .bind('artist-fail')
      .first<any>();
    expect(failedArtistTrackCount.c).toBe(0);

    vi.unstubAllGlobals();
  });

  it('reports zero new inserts when re-run against a DB that already has everything', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('accounts.spotify.com/api/token')) {
        return new Response(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }), { status: 200 });
      }
      if (url.includes('/v1/search')) {
        return new Response(
          JSON.stringify({
            artists: {
              items: [
                { id: 'artist-1', name: 'Shared Artist', genres: ['pop'], images: [{ url: 'http://img/a' }], popularity: 80 },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('/top-tracks')) {
        return new Response(
          JSON.stringify({
            tracks: [
              { id: 'track-1', name: 'Song One', album: { images: [{ url: 'http://img/t1' }] }, preview_url: 'http://preview/1' },
              { id: 'track-2', name: 'Song Two', album: { images: [{ url: 'http://img/t2' }] }, preview_url: null },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', mockFetch);

    const firstRun = await seedCatalog(env as any);
    expect(firstRun.artistsInserted).toBe(1);
    expect(firstRun.tracksInserted).toBe(2);

    // Same DB state, no reset — a second run should find everything already
    // present via INSERT OR IGNORE and report zero *new* inserts, not repeat
    // the first run's counts.
    const secondRun = await seedCatalog(env as any);
    expect(secondRun.artistsInserted).toBe(0);
    expect(secondRun.tracksInserted).toBe(0);
    expect(secondRun.failedArtistIds).toEqual([]);

    vi.unstubAllGlobals();
  });
});
