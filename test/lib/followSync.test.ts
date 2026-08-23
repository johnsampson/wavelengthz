import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { insertTestUser } from '../helpers/createUser';
import { encrypt } from '../../src/lib/crypto';
import {
  SYNC_MAX_ARTISTS_PER_RUN,
  countPendingArtists,
  getFollowSyncStatus,
  hasFollowScope,
  runFollowSync,
  runScheduledFollowSync,
  setFollowSyncEnabled,
  syncFollowForArtist,
} from '../../src/lib/followSync';
import { FOLLOW_SYNC_SCOPE, PLAYLIST_SYNC_SCOPE } from '../../src/lib/spotify';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM spotify_follow_sync_items; DELETE FROM spotify_follow_syncs; DELETE FROM music_swipes; DELETE FROM tracks; DELETE FROM artists; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ALL_SCOPES = `user-top-read streaming ${FOLLOW_SYNC_SCOPE}`;

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

/** Seeds an artist and a swipe on it by `userId`. */
async function likeArtist(userId: string, artistId: string, spotifyId: string | null, swipedAt: number, direction = 'right') {
  await env.DB.prepare(
    `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at, updated_at) VALUES (?, ?, ?, '{}', 'spotify', 1, 1000, 1000)`
  )
    .bind(artistId, spotifyId, `Artist ${artistId}`)
    .run();
  await env.DB.prepare(
    `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES (?, ?, 'artist', ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), userId, artistId, direction, swipedAt, swipedAt)
    .run();
}

/** Stubs only PUT /v1/me/following; anything else throws. */
function stubSpotify(options: { status?: number } = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : null });
      if (url.includes('/me/following') && method === 'PUT') {
        return new Response('', { status: options.status ?? 204 });
      }
      throw new Error(`Unexpected Spotify call: ${method} ${url}`);
    })
  );
  return calls;
}

describe('hasFollowScope', () => {
  it('only matches its own scope, never the playlist one', () => {
    expect(hasFollowScope(`streaming ${FOLLOW_SYNC_SCOPE}`)).toBe(true);
    // The whole point of separate toggles: granting playlist write must not
    // imply permission to change who someone publicly follows.
    expect(hasFollowScope(`streaming ${PLAYLIST_SYNC_SCOPE}`)).toBe(false);
    expect(hasFollowScope('user-follow-read')).toBe(false);
    expect(hasFollowScope(null)).toBe(false);
  });
});

describe('pending artists', () => {
  it('counts only right-swiped artists that carry a Spotify id', async () => {
    await seedUser('u1');
    await likeArtist('u1', 'a1', 'sp-a1', 2000);
    await likeArtist('u1', 'a2', 'sp-a2', 3000, 'left');
    await likeArtist('u1', 'a3', 'sp-a3', 4000, 'skip');
    await likeArtist('u1', 'a4', null, 5000);

    expect(await countPendingArtists(env.DB, 'u1')).toBe(1);
  });

  it('ignores track swipes entirely', async () => {
    // A track right-swipe is a fast, high-volume gesture. Following is
    // public. Only the artist-level like -- including the one
    // likeArtistForTrack cascades -- may produce a follow.
    await seedUser('u1');
    await env.DB.prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at, updated_at) VALUES ('a1', 'sp-a1', 'A', '{}', 'spotify', 1, 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, artist_id, spotify_id, name, source, approved, created_at, updated_at) VALUES ('t1', 'a1', 'sp-t1', 'T', 'spotify', 1, 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES (?, 'u1', 'track', 't1', 'right', 2000, 2000)`
    ).bind(crypto.randomUUID()).run();

    expect(await countPendingArtists(env.DB, 'u1')).toBe(0);
  });

  it('excludes artists already followed, and is scoped per user', async () => {
    await seedUser('u1');
    await seedUser('u2');
    await likeArtist('u1', 'a1', 'sp-a1', 2000);
    await likeArtist('u1', 'a2', 'sp-a2', 3000);
    await env.DB.prepare(
      `INSERT INTO spotify_follow_sync_items (id, user_id, spotify_artist_id, created_at, updated_at) VALUES (?, 'u1', 'sp-a1', 1, 1)`
    ).bind(crypto.randomUUID()).run();

    expect(await countPendingArtists(env.DB, 'u1')).toBe(1);
    expect(await countPendingArtists(env.DB, 'u2')).toBe(0);
  });
});

describe('runFollowSync', () => {
  it('makes no Spotify call when following is disabled', async () => {
    const user = await seedUser('u1');
    await likeArtist('u1', 'a1', 'sp-a1', 2000);
    const calls = stubSpotify();

    expect(await runFollowSync(env, user)).toEqual({ followed: 0, skipped: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('makes no Spotify call when only the playlist scope was granted', async () => {
    const user = await seedUser('u1', `streaming ${PLAYLIST_SYNC_SCOPE}`);
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    await likeArtist('u1', 'a1', 'sp-a1', 2000);
    const calls = stubSpotify();

    expect(await runFollowSync(env, user)).toEqual({ followed: 0, skipped: 'scope_missing' });
    expect(calls).toHaveLength(0);
  });

  it('makes no Spotify call when nothing is pending', async () => {
    const user = await seedUser('u1');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    const calls = stubSpotify();

    expect(await runFollowSync(env, user)).toEqual({ followed: 0 });
    expect(calls).toHaveLength(0);
  });

  it('follows oldest-liked first and records what it sent', async () => {
    const user = await seedUser('u1');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    await likeArtist('u1', 'a2', 'sp-a2', 5000);
    await likeArtist('u1', 'a1', 'sp-a1', 2000);
    const calls = stubSpotify();

    const result = await runFollowSync(env, user);

    expect(result).toEqual({ followed: 2, hasMore: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.ids).toEqual(['sp-a1', 'sp-a2']);
    expect(await countPendingArtists(env.DB, 'u1')).toBe(0);
  });

  it('is idempotent -- a second run sends nothing', async () => {
    const user = await seedUser('u1');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    await likeArtist('u1', 'a1', 'sp-a1', 2000);
    stubSpotify();
    await runFollowSync(env, user);

    const calls = stubSpotify();
    expect(await runFollowSync(env, user)).toEqual({ followed: 0 });
    expect(calls).toHaveLength(0);
  });

  it('batches at 50 ids per call rather than one call per artist', async () => {
    const user = await seedUser('u1');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    for (let i = 0; i < 75; i++) await likeArtist('u1', `a${i}`, `sp-a${i}`, 2000 + i);
    const calls = stubSpotify();

    const result = await runFollowSync(env, user);

    expect(result.followed).toBe(75);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.ids).toHaveLength(50);
    expect(calls[1].body.ids).toHaveLength(25);
  });

  it('caps a large backfill and reports there is more', async () => {
    const user = await seedUser('u1');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    for (let i = 0; i < SYNC_MAX_ARTISTS_PER_RUN + 10; i++) await likeArtist('u1', `a${i}`, `sp-a${i}`, 2000 + i);
    stubSpotify();

    const result = await runFollowSync(env, user);

    expect(result.followed).toBe(SYNC_MAX_ARTISTS_PER_RUN);
    expect(result.hasMore).toBe(true);
    expect(await countPendingArtists(env.DB, 'u1')).toBe(10);
  });

  it('turns following off and asks for reconnect when Spotify revokes access', async () => {
    const user = await seedUser('u1');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    await likeArtist('u1', 'a1', 'sp-a1', 2000);
    stubSpotify({ status: 403 });

    expect(await runFollowSync(env, user)).toEqual({ followed: 0, needsReconnect: true });
    const row = await env.DB.prepare('SELECT enabled, needs_reconnect FROM spotify_follow_syncs WHERE user_id = ?').bind('u1').first<any>();
    expect(row.enabled).toBe(0);
    // Persisted (migrations/0027), not just the one-time result above --
    // issue #127: a later page load must still be able to explain why
    // following is off, not just that it is.
    expect(row.needs_reconnect).toBe(1);
  });

  it('keeps the ledger for a chunk that landed when a later one fails', async () => {
    const user = await seedUser('u1');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    for (let i = 0; i < 75; i++) await likeArtist('u1', `a${i}`, `sp-a${i}`, 2000 + i);

    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      return new Response('', { status: n === 1 ? 204 : 500 });
    }));

    await expect(runFollowSync(env, user)).rejects.toThrow();

    // The 50 that landed are recorded, so a retry sends only the other 25.
    expect(await countPendingArtists(env.DB, 'u1')).toBe(25);
  });
});

describe('syncFollowForArtist', () => {
  it('makes no Spotify call when following is disabled', async () => {
    const user = await seedUser('u1');
    const calls = stubSpotify();

    await syncFollowForArtist(env, user, 'sp-a1');

    expect(calls).toHaveLength(0);
  });

  it('makes no Spotify call when only the playlist scope was granted', async () => {
    const user = await seedUser('u1', `streaming ${PLAYLIST_SYNC_SCOPE}`);
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    const calls = stubSpotify();

    await syncFollowForArtist(env, user, 'sp-a1');

    expect(calls).toHaveLength(0);
  });

  it('follows the artist immediately and records it in the ledger', async () => {
    const user = await seedUser('u1');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    const calls = stubSpotify();

    await syncFollowForArtist(env, user, 'sp-a1', 5000);

    expect(calls).toHaveLength(1);
    expect(calls[0].body.ids).toEqual(['sp-a1']);
    const item = await env.DB.prepare('SELECT * FROM spotify_follow_sync_items WHERE user_id = ? AND spotify_artist_id = ?')
      .bind('u1', 'sp-a1')
      .first<any>();
    expect(item).toBeTruthy();
  });

  it('is idempotent -- skips the Spotify call entirely for an artist already in the ledger', async () => {
    const user = await seedUser('u1');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    stubSpotify();
    await syncFollowForArtist(env, user, 'sp-a1', 2000);

    const calls = stubSpotify();
    await syncFollowForArtist(env, user, 'sp-a1', 3000);

    expect(calls).toHaveLength(0);
  });

  it('does nothing for an empty/missing spotify id', async () => {
    const user = await seedUser('u1');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    const calls = stubSpotify();

    await syncFollowForArtist(env, user, '');

    expect(calls).toHaveLength(0);
  });

  it('turns following off when Spotify revokes access, without throwing', async () => {
    const user = await seedUser('u1');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    stubSpotify({ status: 403 });

    await expect(syncFollowForArtist(env, user, 'sp-a1')).resolves.toBeUndefined();

    const row = await env.DB.prepare('SELECT enabled, needs_reconnect FROM spotify_follow_syncs WHERE user_id = ?').bind('u1').first<any>();
    expect(row.enabled).toBe(0);
    expect(row.needs_reconnect).toBe(1);
  });

  it('swallows a transient failure without throwing, leaving the artist pending for the next sweep', async () => {
    const user = await seedUser('u1');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    await likeArtist('u1', 'a1', 'sp-a1', 2000);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));

    await expect(syncFollowForArtist(env, user, 'sp-a1')).resolves.toBeUndefined();

    // No ledger row was written, so the hourly sweep still has this artist
    // as pending -- nothing was lost, just delayed.
    expect(await countPendingArtists(env.DB, 'u1')).toBe(1);
  });
});

describe('getFollowSyncStatus', () => {
  it('reports scope separately from the enabled flag, with no Spotify call', async () => {
    await seedUser('u1', 'user-top-read streaming');
    await likeArtist('u1', 'a1', 'sp-a1', 2000);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('must not call Spotify'); }));

    expect(await getFollowSyncStatus(env.DB, 'u1')).toEqual({
      enabled: false,
      connected: false,
      lastSyncedAt: null,
      pendingCount: 1,
      followedCount: 0,
      needsReconnect: false,
    });
  });
});

describe('runScheduledFollowSync', () => {
  it('only picks up users who opted in, and skips soft-deleted accounts', async () => {
    await seedUser('u1');
    await seedUser('u2');
    await seedUser('u3');
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    await setFollowSyncEnabled(env.DB, 'u3', true, 1000);
    await likeArtist('u1', 'a1', 'sp-a1', 2000);
    await likeArtist('u2', 'a2', 'sp-a2', 2000);
    await likeArtist('u3', 'a3', 'sp-a3', 2000);
    await env.DB.prepare('UPDATE users SET deleted_at = 1 WHERE id = ?').bind('u3').run();
    stubSpotify();

    expect(await runScheduledFollowSync(env)).toEqual({ users: 1, followed: 1 });
    expect(await countPendingArtists(env.DB, 'u2')).toBe(1);
  });
});
