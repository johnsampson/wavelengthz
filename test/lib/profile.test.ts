import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { getDisplayMusicProfile } from '../../src/lib/profile';
import { insertTestUser } from '../helpers/createUser';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM music_profiles; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', createdAt: 1000, updatedAt: 1000 });
});

describe('getDisplayMusicProfile', () => {
  it('returns empty arrays when the user has no music profile yet', async () => {
    const result = await getDisplayMusicProfile(env.DB, 'u1');
    expect(result).toEqual({ topGenres: [], topArtists: [], topTracks: [] });
  });

  it('returns genres, artists, and tracks with name/imageUrl, ordered by rank', async () => {
    const topArtists = JSON.stringify([
      { artist_id: 'a2', rank: 2, name: 'Second Artist', imageUrl: 'https://img/a2.jpg' },
      { artist_id: 'a1', rank: 1, name: 'First Artist', imageUrl: 'https://img/a1.jpg' },
    ]);
    const topTracks = JSON.stringify([
      { track_id: 't2', rank: 2, name: 'Second Track', imageUrl: 'https://img/t2.jpg' },
      { track_id: 't1', rank: 1, name: 'First Track', imageUrl: 'https://img/t1.jpg' },
    ]);
    const topGenres = JSON.stringify(['pop', 'indie']);
    await env.DB.prepare(
      `INSERT INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at) VALUES ('u1', ?, ?, ?, 'medium_term', 1000)`
    ).bind(topArtists, topTracks, topGenres).run();

    const result = await getDisplayMusicProfile(env.DB, 'u1');

    expect(result.topGenres).toEqual(['pop', 'indie']);
    expect(result.topArtists).toEqual([
      { id: 'a1', name: 'First Artist', imageUrl: 'https://img/a1.jpg' },
      { id: 'a2', name: 'Second Artist', imageUrl: 'https://img/a2.jpg' },
    ]);
    // topTracks' id is already the real Spotify track id (this data is the
    // user's raw cached Spotify "top tracks", never touching the
    // artists/tracks catalog tables) -- spotifyId is exposed anyway so
    // profile.html's embed player can use one uniform field name across all
    // three track lists on the page, regardless of source.
    expect(result.topTracks).toEqual([
      { id: 't1', spotifyId: 't1', name: 'First Track', imageUrl: 'https://img/t1.jpg' },
      { id: 't2', spotifyId: 't2', name: 'Second Track', imageUrl: 'https://img/t2.jpg' },
    ]);
  });

  it('caps artists and tracks at 10 each', async () => {
    const topArtists = JSON.stringify(
      Array.from({ length: 15 }, (_, i) => ({ artist_id: `a${i}`, rank: i + 1, name: `Artist ${i}`, imageUrl: null }))
    );
    await env.DB.prepare(
      `INSERT INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at) VALUES ('u1', ?, '[]', '[]', 'medium_term', 1000)`
    ).bind(topArtists).run();

    const result = await getDisplayMusicProfile(env.DB, 'u1');

    expect(result.topArtists).toHaveLength(10);
    expect(result.topArtists[0].id).toBe('a0');
  });
});
