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

    vi.unstubAllGlobals();
  });

  it('exposes a genre list of at least 10 genres', () => {
    expect(SEED_GENRES.length).toBeGreaterThanOrEqual(10);
  });
});
