import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { insertTestUser } from '../helpers/createUser';
import { encrypt } from '../../src/lib/crypto';
import {
  SYNC_MAX_TRACKS_PER_RUN,
  countPendingTracks,
  getSyncStatus,
  hasPlaylistScope,
  runPlaylistSync,
  runScheduledPlaylistSync,
  setSyncEnabled,
} from '../../src/lib/playlistSync';
import { PLAYLIST_SYNC_SCOPE } from '../../src/lib/spotify';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM spotify_playlist_sync_items; DELETE FROM spotify_playlist_syncs; DELETE FROM music_swipes; DELETE FROM tracks; DELETE FROM artists; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ALL_SCOPES = `user-top-read streaming ${PLAYLIST_SYNC_SCOPE}`;

async function seedUser(id: string, scope: string | null = ALL_SCOPES) {
  await insertTestUser(env.DB, { id, spotifyId: `sp-${id}`, createdAt: 1000, updatedAt: 1000 });
  await env.DB.prepare(
    `UPDATE music_source_tokens SET granted_scope = ?, access_token = ?, refresh_token = ?, token_expires_at = ? WHERE user_id = ?`
  )
    .bind(
      scope,
      await encrypt('live-access-token', env.TOKEN_ENCRYPTION_KEY),
      await encrypt('live-refresh-token', env.TOKEN_ENCRYPTION_KEY),
      Date.now() + 3_600_000,
      id
    )
    .run();
  return { id, spotify_id: `sp-${id}` } as any;
}

async function seedArtist(id: string) {
  await env.DB.prepare(
    `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at, updated_at) VALUES (?, ?, ?, '{}', 'spotify', 1, 1000, 1000)`
  )
    .bind(id, `sp-${id}`, `Artist ${id}`)
    .run();
}

/** Seeds a catalog track and a right-swipe on it by `userId`. */
async function likeTrack(userId: string, trackId: string, spotifyId: string | null, swipedAt: number, direction = 'right') {
  await env.DB.prepare(
    `INSERT INTO tracks (id, artist_id, spotify_id, name, source, approved, created_at, updated_at) VALUES (?, 'a1', ?, ?, 'spotify', 1, 1000, 1000)`
  )
    .bind(trackId, spotifyId, `Track ${trackId}`)
    .run();
  await env.DB.prepare(
    `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES (?, ?, 'track', ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), userId, trackId, direction, swipedAt, swipedAt)
    .run();
}

/**
 * Stubs exactly the three endpoints a sync run is allowed to touch. Anything
 * else throws, so a test asserting "no Spotify call happened" fails loudly
 * rather than silently passing on a call nobody looked at.
 */
function stubSpotify(options: { addStatus?: number; createStatus?: number; playlistStatus?: number; ownerId?: string } = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : null });

    // Order matters: a create is POST /v1/users/{id}/playlists, which also
    // contains "/playlists" -- match the more specific shape first.
    if (url.includes('/users/') && url.endsWith('/playlists') && method === 'POST') {
      const status = options.createStatus ?? 201;
      if (status !== 201) return new Response('nope', { status });
      return new Response(
        JSON.stringify({ id: 'pl1', external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' } }),
        { status: 201 }
      );
    }
    if (/\/playlists\/[^/]+\/tracks/.test(url) && method === 'POST') {
      const status = options.addStatus ?? 201;
      return new Response(status === 201 ? '{}' : 'nope', { status });
    }
    if (url.includes('/playlists/') && method === 'GET') {
      const status = options.playlistStatus ?? 200;
      if (status !== 200) return new Response('gone', { status });
      return new Response(JSON.stringify({ id: 'pl1', owner: { id: options.ownerId ?? 'sp-u1' } }), { status: 200 });
    }
    throw new Error(`Unexpected Spotify call: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const addCalls = (calls: Array<{ url: string; method: string; body: any }>) =>
  calls.filter((c) => c.method === 'POST' && /\/playlists\/[^/]+\/tracks/.test(c.url));

describe('hasPlaylistScope', () => {
  it('only matches a whole scope, never a substring of a longer one', () => {
    expect(hasPlaylistScope(`streaming ${PLAYLIST_SYNC_SCOPE}`)).toBe(true);
    expect(hasPlaylistScope('streaming user-top-read')).toBe(false);
    // The public variant grants strictly more, but it is NOT what this app
    // requests, and treating it as equivalent would let a grant this app
    // never asked for silently enable writes.
    expect(hasPlaylistScope('playlist-modify-public')).toBe(false);
    expect(hasPlaylistScope(null)).toBe(false);
    expect(hasPlaylistScope(undefined)).toBe(false);
  });
});

describe('pending tracks', () => {
  beforeEach(async () => {
    await seedArtist('a1');
  });

  it('counts only right-swiped tracks that carry a Spotify id', async () => {
    await seedUser('u1');
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    await likeTrack('u1', 't2', 'sp-t2', 3000, 'left');
    await likeTrack('u1', 't3', 'sp-t3', 4000, 'skip');
    await likeTrack('u1', 't4', null, 5000);

    expect(await countPendingTracks(env.DB, 'u1')).toBe(1);
  });

  it('excludes tracks already recorded as sent, and is scoped per user', async () => {
    await seedUser('u1');
    await seedUser('u2');
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    await likeTrack('u1', 't2', 'sp-t2', 3000);
    await env.DB.prepare(
      `INSERT INTO spotify_playlist_sync_items (id, user_id, spotify_track_id, created_at, updated_at) VALUES (?, 'u1', 'sp-t1', 1, 1)`
    )
      .bind(crypto.randomUUID())
      .run();

    expect(await countPendingTracks(env.DB, 'u1')).toBe(1);
    // u2 liked nothing -- u1's ledger and swipes must not leak across.
    expect(await countPendingTracks(env.DB, 'u2')).toBe(0);
  });
});

describe('runPlaylistSync', () => {
  beforeEach(async () => {
    await seedArtist('a1');
  });

  it('makes no Spotify call at all when sync is disabled', async () => {
    const user = await seedUser('u1');
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    const calls = stubSpotify();

    expect(await runPlaylistSync(env, user)).toEqual({ added: 0, skipped: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('makes no Spotify call when the write scope was never granted', async () => {
    const user = await seedUser('u1', 'user-top-read streaming');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    const calls = stubSpotify();

    expect(await runPlaylistSync(env, user)).toEqual({ added: 0, skipped: 'scope_missing' });
    expect(calls).toHaveLength(0);
  });

  it('makes no Spotify call when there is nothing pending', async () => {
    const user = await seedUser('u1');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    const calls = stubSpotify();

    expect(await runPlaylistSync(env, user)).toEqual({ added: 0 });
    expect(calls).toHaveLength(0);
    // Still stamps the run, so "last synced" reflects a real check.
    const row = await env.DB.prepare('SELECT last_synced_at FROM spotify_playlist_syncs WHERE user_id = ?').bind('u1').first<any>();
    expect(row.last_synced_at).toBeGreaterThan(0);
  });

  it('creates the playlist, adds tracks oldest-liked first, and records what it sent', async () => {
    const user = await seedUser('u1');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    await likeTrack('u1', 't2', 'sp-t2', 5000);
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    const calls = stubSpotify();

    const result = await runPlaylistSync(env, user);

    expect(result).toEqual({ added: 2, hasMore: false });
    const adds = addCalls(calls);
    expect(adds).toHaveLength(1);
    expect(adds[0].body.uris).toEqual(['spotify:track:sp-t1', 'spotify:track:sp-t2']);

    const row = await env.DB.prepare('SELECT playlist_id, playlist_url FROM spotify_playlist_syncs WHERE user_id = ?').bind('u1').first<any>();
    expect(row.playlist_id).toBe('pl1');
    expect(row.playlist_url).toBe('https://open.spotify.com/playlist/pl1');
    expect(await countPendingTracks(env.DB, 'u1')).toBe(0);
  });

  it('creates the playlist as private, never public', async () => {
    const user = await seedUser('u1');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    const calls = stubSpotify();

    await runPlaylistSync(env, user);

    const create = calls.find((c) => c.url.includes('/users/') && c.method === 'POST');
    expect(create?.body.public).toBe(false);
  });

  it('is idempotent -- a second run sends nothing and adds no duplicates', async () => {
    const user = await seedUser('u1');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    await likeTrack('u1', 't1', 'sp-t1', 2000);

    stubSpotify();
    await runPlaylistSync(env, user);

    const calls = stubSpotify();
    const second = await runPlaylistSync(env, user);

    expect(second).toEqual({ added: 0 });
    expect(addCalls(calls)).toHaveLength(0);
  });

  it('reuses the existing playlist rather than creating a new one each run', async () => {
    const user = await seedUser('u1');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    stubSpotify();
    await runPlaylistSync(env, user);

    await likeTrack('u1', 't2', 'sp-t2', 3000);
    const calls = stubSpotify();
    await runPlaylistSync(env, user);

    expect(calls.filter((c) => c.url.includes('/users/') && c.method === 'POST')).toHaveLength(0);
    expect(addCalls(calls)).toHaveLength(1);
  });

  it('recreates the playlist -- and clears the ledger -- when the old one is gone', async () => {
    const user = await seedUser('u1');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    stubSpotify();
    await runPlaylistSync(env, user);
    expect(await countPendingTracks(env.DB, 'u1')).toBe(0);

    // User deleted the playlist in Spotify, then likes something new.
    await likeTrack('u1', 't2', 'sp-t2', 3000);
    const calls = stubSpotify({ playlistStatus: 404 });
    const result = await runPlaylistSync(env, user);

    // Everything gets re-sent: the previously-synced track is not in the new
    // playlist, so refusing to re-add it would strand it forever.
    expect(result.added).toBe(2);
    expect(addCalls(calls)[0].body.uris).toEqual(['spotify:track:sp-t1', 'spotify:track:sp-t2']);
  });

  it('treats a playlist owned by somebody else as not ours to write to', async () => {
    const user = await seedUser('u1');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    stubSpotify();
    await runPlaylistSync(env, user);

    await likeTrack('u1', 't2', 'sp-t2', 3000);
    const calls = stubSpotify({ ownerId: 'somebody-else' });
    await runPlaylistSync(env, user);

    expect(calls.filter((c) => c.url.includes('/users/') && c.method === 'POST')).toHaveLength(1);
  });

  it('batches into calls of at most 100 uris rather than one call per track', async () => {
    const user = await seedUser('u1');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    for (let i = 0; i < 150; i++) await likeTrack('u1', `t${i}`, `sp-t${i}`, 2000 + i);
    const calls = stubSpotify();

    const result = await runPlaylistSync(env, user);

    expect(result.added).toBe(150);
    const adds = addCalls(calls);
    expect(adds).toHaveLength(2);
    expect(adds[0].body.uris).toHaveLength(100);
    expect(adds[1].body.uris).toHaveLength(50);
  });

  it('caps a huge backfill at SYNC_MAX_TRACKS_PER_RUN and reports there is more', async () => {
    const user = await seedUser('u1');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    for (let i = 0; i < SYNC_MAX_TRACKS_PER_RUN + 25; i++) await likeTrack('u1', `t${i}`, `sp-t${i}`, 2000 + i);
    stubSpotify();

    const result = await runPlaylistSync(env, user);

    expect(result.added).toBe(SYNC_MAX_TRACKS_PER_RUN);
    expect(result.hasMore).toBe(true);
    // The remainder is still pending, so the next run picks it up -- nothing
    // is dropped by the cap.
    expect(await countPendingTracks(env.DB, 'u1')).toBe(25);
  });

  it('turns sync off and asks for reconnect when Spotify revokes write access', async () => {
    const user = await seedUser('u1');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    stubSpotify({ createStatus: 403 });

    const result = await runPlaylistSync(env, user);

    expect(result).toEqual({ added: 0, needsReconnect: true });
    const row = await env.DB.prepare('SELECT enabled FROM spotify_playlist_syncs WHERE user_id = ?').bind('u1').first<any>();
    expect(row.enabled).toBe(0);
  });

  it('keeps the ledger for chunks that already landed when a later chunk fails', async () => {
    const user = await seedUser('u1');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    for (let i = 0; i < 150; i++) await likeTrack('u1', `t${i}`, `sp-t${i}`, 2000 + i);

    let addCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? 'GET';
        if (url.includes('/users/') && method === 'POST') {
          return new Response(JSON.stringify({ id: 'pl1', external_urls: { spotify: 'u' } }), { status: 201 });
        }
        if (/\/playlists\/[^/]+\/tracks/.test(url)) {
          addCount++;
          // First chunk lands, second fails outright.
          return new Response('{}', { status: addCount === 1 ? 201 : 500 });
        }
        throw new Error(`Unexpected call ${method} ${url}`);
      })
    );

    await expect(runPlaylistSync(env, user)).rejects.toThrow();

    // The 100 that made it are recorded, so the retry sends only the other 50
    // instead of duplicating everything.
    expect(await countPendingTracks(env.DB, 'u1')).toBe(50);
  });
});

describe('getSyncStatus', () => {
  it('reports scope separately from the enabled flag, with no Spotify call', async () => {
    await seedArtist('a1');
    await seedUser('u1', 'user-top-read streaming');
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getSyncStatus must not call Spotify'); }));

    const status = await getSyncStatus(env.DB, 'u1');

    expect(status).toEqual({
      enabled: false,
      connected: false,
      playlistUrl: null,
      lastSyncedAt: null,
      pendingCount: 1,
      syncedCount: 0,
    });
  });
});

describe('runScheduledPlaylistSync', () => {
  beforeEach(async () => {
    await seedArtist('a1');
  });

  it('only picks up users who opted in', async () => {
    await seedUser('u1');
    await seedUser('u2');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    await likeTrack('u2', 't2', 'sp-t2', 2000);
    const calls = stubSpotify();

    const result = await runScheduledPlaylistSync(env);

    expect(result).toEqual({ users: 1, added: 1 });
    expect(addCalls(calls)).toHaveLength(1);
    expect(await countPendingTracks(env.DB, 'u2')).toBe(1);
  });

  it('skips a soft-deleted account', async () => {
    await seedUser('u1');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    await env.DB.prepare('UPDATE users SET deleted_at = 1 WHERE id = ?').bind('u1').run();
    const calls = stubSpotify();

    expect(await runScheduledPlaylistSync(env)).toEqual({ users: 0, added: 0 });
    expect(calls).toHaveLength(0);
  });

  it('keeps going when one user fails', async () => {
    await seedUser('u1');
    await seedUser('u2');
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    await setSyncEnabled(env.DB, 'u2', true, 1000);
    await likeTrack('u1', 't1', 'sp-t1', 2000);
    await likeTrack('u2', 't2', 'sp-t2', 2000);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = input.toString();
        // u1's playlist creation blows up; u2's succeeds.
        if (url.includes('/users/sp-u1/playlists')) return new Response('boom', { status: 500 });
        if (url.includes('/users/') && (init?.method ?? 'GET') === 'POST') {
          return new Response(JSON.stringify({ id: 'pl2', external_urls: { spotify: 'u' } }), { status: 201 });
        }
        return new Response('{}', { status: 201 });
      })
    );

    const result = await runScheduledPlaylistSync(env);

    expect(result).toEqual({ users: 2, added: 1 });
    expect(await countPendingTracks(env.DB, 'u2')).toBe(0);
    expect(await countPendingTracks(env.DB, 'u1')).toBe(1);
  });
});
