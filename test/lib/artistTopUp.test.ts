import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { topUpArtistsForUser } from '../../src/lib/artistTopUp';
import type { UserRow } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM genres; DELETE FROM tracks; DELETE FROM artists; DELETE FROM user_genres; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', createdAt: 1000, updatedAt: 1000 });
});

async function loadUser(): Promise<UserRow> {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first<UserRow>() as Promise<UserRow>;
}

function stubSpotify(artistsByGenre: Record<string, any[]>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      if (url.includes('type=artist')) {
        const match = decodeURIComponent(url).match(/genre:"([^"]+)"/);
        const genre = match ? match[1] : '';
        return new Response(JSON.stringify({ artists: { items: artistsByGenre[genre] ?? [] } }), { status: 200 });
      }
      if (url.includes('/albums')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    })
  );
}

describe('topUpArtistsForUser', () => {
  it('inserts artists from the user\'s top genre by affinity', async () => {
    await env.DB.prepare(
      `INSERT INTO user_genres (id, user_id, genre, artist_count, track_count, created_at, updated_at) VALUES ('ug1', 'u1', 'indie', 5, 2, 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_genres (id, user_id, genre, artist_count, track_count, created_at, updated_at) VALUES ('ug2', 'u1', 'pop', 1, 0, 1000, 1000)`
    ).run();
    stubSpotify({
      indie: [{ id: 'a1', name: 'Indie Artist', genres: ['indie'], images: [{ url: 'https://img/a1.jpg' }], popularity: 50 }],
    });

    const inserted = await topUpArtistsForUser({ ...env, TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY } as any, await loadUser());

    expect(inserted).toBe(1);
    const row = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('a1').first<any>();
    expect(row).toBeTruthy();
    expect(row.image_url).toBe('https://img/a1.jpg');
    vi.unstubAllGlobals();
  });

  it('falls back to a generic genre set for a user with no genre affinity yet', async () => {
    stubSpotify({
      pop: [{ id: 'a2', name: 'Pop Artist', genres: ['pop'], images: [{ url: 'https://img/a2.jpg' }], popularity: 50 }],
    });

    const inserted = await topUpArtistsForUser(env as any, await loadUser());

    expect(inserted).toBe(1);
    const row = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('a2').first<any>();
    expect(row).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('skips an artist with no photo -- it could never surface as a candidate anyway', async () => {
    stubSpotify({
      pop: [{ id: 'a3', name: 'No Photo Artist', genres: ['pop'], images: [], popularity: 50 }],
    });

    const inserted = await topUpArtistsForUser(env as any, await loadUser());

    expect(inserted).toBe(0);
    const row = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('a3').first<any>();
    expect(row).toBeNull();
    vi.unstubAllGlobals();
  });

  it('skips an artist already in the catalog', async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, image_url, source, approved, created_at) VALUES ('a4', 'a4', 'Existing', '{}', '/x.jpg', 'seed', 1, 1000)`
    ).run();
    stubSpotify({
      pop: [{ id: 'a4', name: 'Existing', genres: ['pop'], images: [{ url: 'https://img/a4.jpg' }], popularity: 50 }],
    });

    const inserted = await topUpArtistsForUser(env as any, await loadUser());

    expect(inserted).toBe(0);
    vi.unstubAllGlobals();
  });

  it('stops once TOP_UP_COUNT artists have been inserted', async () => {
    const artists = Array.from({ length: 15 }, (_, i) => ({
      id: `a${i}`,
      name: `Artist ${i}`,
      genres: ['pop'],
      images: [{ url: `https://img/a${i}.jpg` }],
      popularity: 50,
    }));
    stubSpotify({ pop: artists });

    const inserted = await topUpArtistsForUser(env as any, await loadUser());

    expect(inserted).toBe(10);
    vi.unstubAllGlobals();
  });
});
