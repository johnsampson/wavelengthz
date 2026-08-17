import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { resolveSharedTrack, loadSharedTracks } from '../../src/lib/trackSharing';
import { insertTestUser } from '../helpers/createUser';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  // Children before parents -- messages/group_messages now reference
  // tracks(track_id) (migrations/0021), and tracks reference artists + users.
  await env.DB.exec(
    'DELETE FROM messages; DELETE FROM group_messages; DELETE FROM notifications; DELETE FROM matches; ' +
      'DELETE FROM group_members; DELETE FROM groups; DELETE FROM music_swipes; DELETE FROM user_genres; ' +
      'DELETE FROM genres; DELETE FROM tracks; DELETE FROM artists; DELETE FROM sessions; ' +
      'DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp-u1', createdAt: 1000, updatedAt: 1000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function spotifyTrack(id: string, artistId = 'sp-artist-1') {
  return {
    id,
    name: `Track ${id}`,
    artists: [{ id: artistId, name: 'Some Artist' }],
    album: { images: [{ url: `https://img.example/${id}.jpg` }] },
    preview_url: null,
  };
}

/** Allows only the token + GET /v1/artists/{id}; anything else throws. */
function stubArtistLookup() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      if (url.includes('/v1/artists/')) {
        return new Response(
          JSON.stringify({ id: 'sp-artist-1', name: 'Some Artist', genres: ['indie'], images: [{ url: 'https://img.example/a.jpg' }], popularity: 60 }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    })
  );
  return calls;
}

describe('resolveSharedTrack', () => {
  it('creates the artist and the track, returning the internal track id', async () => {
    stubArtistLookup();

    const result = await resolveSharedTrack(env as any, spotifyTrack('sp-t1'), 'u1');

    expect('trackId' in result).toBe(true);
    const row = await env.DB.prepare('SELECT * FROM tracks WHERE spotify_id = ?').bind('sp-t1').first<any>();
    expect(row).not.toBeNull();
    expect((result as any).trackId).toBe(row.id);
    // Internal UUID, never the Spotify id (migrations/0002).
    expect(row.id).not.toBe('sp-t1');
    expect(row.source).toBe('user_added');
    expect(row.added_by_user_id).toBe('u1');
  });

  it('is DB-first: an already-cataloged track costs zero Spotify calls', async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at) VALUES ('a1', 'sp-artist-1', 'Some Artist', '{}', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, source, approved, created_at) VALUES ('known-t', 'sp-t1', 'Track', 'a1', 'seed', 1, 1000)`
    ).run();
    const calls = stubArtistLookup();

    const result = await resolveSharedTrack(env as any, spotifyTrack('sp-t1'), 'u1');

    expect(result).toEqual({ trackId: 'known-t' });
    expect(calls).toEqual([]);
  });

  it('reuses a known artist without re-fetching it, for a brand-new track', async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at) VALUES ('a1', 'sp-artist-1', 'Some Artist', '{}', 'seed', 1, 1000)`
    ).run();
    const calls = stubArtistLookup();

    const result = await resolveSharedTrack(env as any, spotifyTrack('sp-new'), 'u1');

    expect('trackId' in result).toBe(true);
    expect(calls).toEqual([]); // artist already known -> no token, no artist fetch
    const row = await env.DB.prepare('SELECT artist_id FROM tracks WHERE spotify_id = ?').bind('sp-new').first<any>();
    expect(row.artist_id).toBe('a1');
  });

  it('never calls GET /v1/tracks/{id} -- the search payload already carries everything', async () => {
    const calls = stubArtistLookup();

    await resolveSharedTrack(env as any, spotifyTrack('sp-t1'), 'u1');

    expect(calls.some((c) => c.includes('/v1/tracks/'))).toBe(false);
    expect(calls.some((c) => c.includes('/albums'))).toBe(false);
  });

  it('rejects a track with no id or name', async () => {
    expect(await resolveSharedTrack(env as any, { id: '', name: 'x' } as any, 'u1')).toEqual({ error: 'invalid_track' });
    expect(await resolveSharedTrack(env as any, { id: 'x', name: '' } as any, 'u1')).toEqual({ error: 'invalid_track' });
  });

  it('rejects a track with no artist, since tracks.artist_id is NOT NULL', async () => {
    const result = await resolveSharedTrack(env as any, { id: 'sp-x', name: 'Orphan', artists: [] } as any, 'u1');
    expect(result).toEqual({ error: 'invalid_track' });
  });

  it('reports artist_unavailable rather than storing a track when Spotify fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    const result = await resolveSharedTrack(env as any, spotifyTrack('sp-t1'), 'u1');

    expect(result).toEqual({ error: 'artist_unavailable' });
    expect(await env.DB.prepare('SELECT 1 FROM tracks WHERE spotify_id = ?').bind('sp-t1').first()).toBeNull();
  });

  it('records catalog genres for a newly-added artist and track', async () => {
    stubArtistLookup();

    await resolveSharedTrack(env as any, spotifyTrack('sp-t1'), 'u1');

    const genre = await env.DB.prepare('SELECT * FROM genres WHERE genre = ?').bind('indie').first<any>();
    expect(genre.artist_count).toBe(1);
    expect(genre.track_count).toBe(1);
  });
});

describe('loadSharedTracks', () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at) VALUES ('a1', 'sp-a1', 'The Artist', '{}', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, album_image_url, duration_ms, source, approved, created_at) VALUES ('t1', 'sp-t1', 'Song One', 'a1', 'https://img/t1.jpg', 210000, 'seed', 1, 1000)`
    ).run();
  });

  it('returns a renderable view keyed by internal id, with the artist name joined in', async () => {
    const map = await loadSharedTracks(env.DB, ['t1']);
    expect(map.get('t1')).toEqual({
      id: 't1',
      spotifyId: 'sp-t1',
      name: 'Song One',
      artistName: 'The Artist',
      imageUrl: 'https://img/t1.jpg',
      durationMs: 210000,
    });
  });

  it('handles an empty list without querying', async () => {
    expect((await loadSharedTracks(env.DB, [])).size).toBe(0);
  });

  it('ignores nulls and dedupes repeats -- a thread re-sending one song must not fan out queries', async () => {
    const map = await loadSharedTracks(env.DB, ['t1', 't1', null as any, undefined as any]);
    expect(map.size).toBe(1);
  });

  it('simply omits an id with no matching row rather than throwing', async () => {
    const map = await loadSharedTracks(env.DB, ['t1', 'does-not-exist']);
    expect(map.has('t1')).toBe(true);
    expect(map.has('does-not-exist')).toBe(false);
  });
});
