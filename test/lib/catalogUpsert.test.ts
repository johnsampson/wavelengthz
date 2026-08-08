import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { upsertArtist, upsertTrack } from '../../src/lib/catalogUpsert';
import { insertTestUser } from '../helpers/createUser';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM genres; DELETE FROM music_swipes; DELETE FROM tracks; DELETE FROM artists; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', createdAt: 1000, updatedAt: 1000 });
});

describe('upsertArtist', () => {
  it('inserts a new artist with a generated UUID id, distinct from the Spotify id', async () => {
    const { id, inserted } = await upsertArtist(
      env.DB,
      { id: 'spotify-artist-1', name: 'New Artist', genres: ['indie'], images: [{ url: 'https://img/a.jpg' }], popularity: 40 },
      'seed',
      null,
      1000
    );
    expect(inserted).toBe(true);
    expect(id).not.toBe('spotify-artist-1');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const row = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind(id).first<any>();
    expect(row.spotify_id).toBe('spotify-artist-1');
    expect(row.name).toBe('New Artist');
    expect(row.source).toBe('seed');
  });

  it('returns the existing internal id on a repeat call for the same Spotify artist, without inserting again', async () => {
    const first = await upsertArtist(env.DB, { id: 'spotify-artist-1', name: 'New Artist', genres: [] }, 'seed', null, 1000);
    const second = await upsertArtist(env.DB, { id: 'spotify-artist-1', name: 'New Artist (refetched)', genres: [] }, 'seed', null, 2000);

    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);

    const count = await env.DB.prepare('SELECT COUNT(*) as c FROM artists WHERE spotify_id = ?').bind('spotify-artist-1').first<any>();
    expect(count.c).toBe(1);
  });
});

describe('upsertTrack', () => {
  it('inserts a new track with a generated UUID id, pointed at the artist\'s internal id', async () => {
    const artist = await upsertArtist(env.DB, { id: 'spotify-artist-1', name: 'Artist', genres: [] }, 'seed', null, 1000);
    const { id, inserted } = await upsertTrack(
      env.DB,
      { id: 'spotify-track-1', name: 'New Track', album: { images: [{ url: 'https://img/t.jpg' }] }, preview_url: null },
      artist.id,
      'seed',
      null,
      1000
    );
    expect(inserted).toBe(true);
    expect(id).not.toBe('spotify-track-1');

    const row = await env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind(id).first<any>();
    expect(row.spotify_id).toBe('spotify-track-1');
    expect(row.artist_id).toBe(artist.id);
  });

  it('returns the existing internal id on a repeat call for the same Spotify track, without inserting again', async () => {
    const artist = await upsertArtist(env.DB, { id: 'spotify-artist-1', name: 'Artist', genres: [] }, 'seed', null, 1000);
    const first = await upsertTrack(env.DB, { id: 'spotify-track-1', name: 'Track' }, artist.id, 'seed', null, 1000);
    const second = await upsertTrack(env.DB, { id: 'spotify-track-1', name: 'Track (refetched)' }, artist.id, 'seed', null, 2000);

    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);

    const count = await env.DB.prepare('SELECT COUNT(*) as c FROM tracks WHERE spotify_id = ?').bind('spotify-track-1').first<any>();
    expect(count.c).toBe(1);
  });
});
