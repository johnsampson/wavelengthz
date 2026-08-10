import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { getDisplayMusicProfile, pickAnthemTrack, getAnthemTracksForUsers } from '../../src/lib/profile';
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
      `INSERT INTO music_profiles (id, user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at, created_at, updated_at) VALUES ('mp3', 'u1', ?, ?, ?, 'medium_term', 1000, 1000, 1000)`
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
      `INSERT INTO music_profiles (id, user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at, created_at, updated_at) VALUES ('mp4', 'u1', ?, '[]', '[]', 'medium_term', 1000, 1000, 1000)`
    ).bind(topArtists).run();

    const result = await getDisplayMusicProfile(env.DB, 'u1');

    expect(result.topArtists).toHaveLength(10);
    expect(result.topArtists[0].id).toBe('a0');
  });
});

describe('pickAnthemTrack', () => {
  const topTracks = [
    { id: 't1', spotifyId: 't1', name: 'First Track', imageUrl: 'https://img/t1.jpg' },
    { id: 't2', spotifyId: 't2', name: 'Second Track', imageUrl: 'https://img/t2.jpg' },
  ];

  it('returns null when no anthem is set', () => {
    expect(pickAnthemTrack(topTracks, null)).toBeNull();
  });

  it('returns the matching track', () => {
    expect(pickAnthemTrack(topTracks, 't2')).toEqual(topTracks[1]);
  });

  it('returns null when the chosen id has fallen out of top_tracks on a refresh', () => {
    expect(pickAnthemTrack(topTracks, 'no-longer-in-top-tracks')).toBeNull();
  });
});

describe('getAnthemTracksForUsers', () => {
  it('returns an empty map without querying when nobody in the batch has an anthem set', async () => {
    let queried = false;
    const spyDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          queried = true;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await getAnthemTracksForUsers(spyDb, [{ id: 'u1', anthem_track_id: null }]);

    expect(result.size).toBe(0);
    expect(queried).toBe(false);
  });

  it('resolves each user\'s anthem from their own top_tracks', async () => {
    await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp2', createdAt: 1000, updatedAt: 1000 });
    const topTracks1 = JSON.stringify([{ track_id: 't1', rank: 1, name: 'My Anthem', imageUrl: 'https://img/t1.jpg' }]);
    const topTracks2 = JSON.stringify([{ track_id: 't9', rank: 1, name: 'Their Anthem', imageUrl: 'https://img/t9.jpg' }]);
    await env.DB.prepare(
      `INSERT INTO music_profiles (id, user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at, created_at, updated_at) VALUES ('mp5', 'u1', '[]', ?, '[]', 'medium_term', 1000, 1000, 1000)`
    ).bind(topTracks1).run();
    await env.DB.prepare(
      `INSERT INTO music_profiles (id, user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at, created_at, updated_at) VALUES ('mp6', 'u2', '[]', ?, '[]', 'medium_term', 1000, 1000, 1000)`
    ).bind(topTracks2).run();

    const result = await getAnthemTracksForUsers(env.DB, [
      { id: 'u1', anthem_track_id: 't1' },
      { id: 'u2', anthem_track_id: 't9' },
    ]);

    expect(result.get('u1')).toEqual({ id: 't1', spotifyId: 't1', name: 'My Anthem', imageUrl: 'https://img/t1.jpg' });
    expect(result.get('u2')).toEqual({ id: 't9', spotifyId: 't9', name: 'Their Anthem', imageUrl: 'https://img/t9.jpg' });
  });

  it('omits a user whose chosen anthem has fallen out of their top_tracks', async () => {
    const topTracks = JSON.stringify([{ track_id: 't1', rank: 1, name: 'First Track', imageUrl: null }]);
    await env.DB.prepare(
      `INSERT INTO music_profiles (id, user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at, created_at, updated_at) VALUES ('mp7', 'u1', '[]', ?, '[]', 'medium_term', 1000, 1000, 1000)`
    ).bind(topTracks).run();

    const result = await getAnthemTracksForUsers(env.DB, [{ id: 'u1', anthem_track_id: 'stale-track-id' }]);

    expect(result.has('u1')).toBe(false);
  });
});
