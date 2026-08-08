import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { refreshCatalogFromProfiles } from '../../src/db/catalogRefresh';
import { insertTestUser } from '../helpers/createUser';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM genres; DELETE FROM music_profiles; DELETE FROM artists; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', createdAt: 1000, updatedAt: 1000 });
  await env.DB.prepare(`INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at) VALUES ('already-known', 'already-known', 'Known Artist', '[]', 'seed', 1, 1000)`).run();
});

describe('refreshCatalogFromProfiles', () => {
  it('adds only the artists missing from the catalog, fetching each exactly once', async () => {
    await env.DB.prepare(
      `INSERT INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at)
       VALUES ('u1', ?, '[]', '[]', 'medium_term', 1000)`
    ).bind(JSON.stringify([{ artist_id: 'already-known', rank: 1 }, { artist_id: 'new-artist', rank: 2 }])).run();

    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      if (url.includes('/v1/artists/new-artist')) {
        return new Response(JSON.stringify({ id: 'new-artist', name: 'New Artist', genres: ['indie'], images: [], popularity: 40 }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshCatalogFromProfiles(env as any);

    expect(result.artistsAdded).toBe(1);
    const row = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('new-artist').first<any>();
    expect(row.source).toBe('spotify_search');
    expect(fetchMock.mock.calls.some((c) => c[0].toString().includes('/v1/artists/already-known'))).toBe(false);

    const genreRow = await env.DB.prepare('SELECT * FROM genres WHERE genre = ?').bind('indie').first<any>();
    expect(genreRow.artist_count).toBe(1);

    vi.unstubAllGlobals();
  });

  it('skips an artist whose fetch fails, without aborting the rest of the run', async () => {
    await env.DB.prepare(
      `INSERT INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at)
       VALUES ('u1', ?, '[]', '[]', 'medium_term', 1000)`
    )
      .bind(
        JSON.stringify([
          { artist_id: 'already-known', rank: 1 },
          { artist_id: 'artist-ok', rank: 2 },
          { artist_id: 'artist-fail', rank: 3 },
        ])
      )
      .run();

    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      if (url.includes('/v1/artists/artist-ok')) {
        return new Response(JSON.stringify({ id: 'artist-ok', name: 'Reliable Artist', genres: ['pop'], images: [], popularity: 70 }), { status: 200 });
      }
      if (url.includes('/v1/artists/artist-fail')) {
        // simulate a transient upstream failure (e.g. 429/500) for this one artist
        return new Response('server error', { status: 500 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshCatalogFromProfiles(env as any);

    expect(result.artistsAdded).toBe(1);
    expect(result.failedArtistIds).toEqual(['artist-fail']);

    const okRow = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('artist-ok').first<any>();
    expect(okRow).not.toBeNull();

    const failedRow = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('artist-fail').first<any>();
    expect(failedRow).toBeNull();

    vi.unstubAllGlobals();
  });
});
