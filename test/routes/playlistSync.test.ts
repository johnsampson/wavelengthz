import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import { setSyncEnabled } from '../../src/lib/playlistSync';
import { PLAYLIST_SYNC_SCOPE } from '../../src/lib/spotify';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM spotify_playlist_sync_items; DELETE FROM spotify_playlist_syncs; DELETE FROM music_swipes; DELETE FROM tracks; DELETE FROM artists; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp-u1', createdAt: 1000, updatedAt: 1000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

async function call(path: string, cookie?: string, method = 'GET') {
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, { method, headers: cookie ? { Cookie: cookie } : {} }),
    env,
    {} as ExecutionContext
  );
  return { status: res.status, body: res.ok ? await res.json<any>() : null };
}

async function grantScope(userId: string, scope: string) {
  await env.DB.prepare(`UPDATE music_source_tokens SET granted_scope = ? WHERE user_id = ?`).bind(scope, userId).run();
}

describe('GET /api/me/playlist-sync', () => {
  it('requires a session', async () => {
    expect((await call('/api/me/playlist-sync')).status).toBe(401);
  });

  it('reports off-and-unconnected for an account that never opted in', async () => {
    const { status, body } = await call('/api/me/playlist-sync', await cookieFor('u1'));

    expect(status).toBe(200);
    expect(body).toEqual({
      enabled: false,
      connected: false,
      playlistUrl: null,
      lastSyncedAt: null,
      pendingCount: 0,
      syncedCount: 0,
      needsReconnect: false,
    });
  });

  it('reports the write scope as connected once it is actually granted', async () => {
    await grantScope('u1', `streaming ${PLAYLIST_SYNC_SCOPE}`);

    const { body } = await call('/api/me/playlist-sync', await cookieFor('u1'));

    expect(body.connected).toBe(true);
    // Granting the scope is not the same as switching sync on -- the flag
    // stays off until something explicitly sets it.
    expect(body.enabled).toBe(false);
  });

  it('makes no Spotify call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('must not call Spotify'); }));

    expect((await call('/api/me/playlist-sync', await cookieFor('u1'))).status).toBe(200);
  });
});

describe('POST /api/me/playlist-sync/disable', () => {
  it('requires a session', async () => {
    expect((await call('/api/me/playlist-sync/disable', undefined, 'POST')).status).toBe(401);
  });

  it('turns sync off without touching the ledger of what was already sent', async () => {
    await grantScope('u1', `streaming ${PLAYLIST_SYNC_SCOPE}`);
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    await env.DB.prepare(
      `INSERT INTO spotify_playlist_sync_items (id, user_id, spotify_track_id, created_at, updated_at) VALUES (?, 'u1', 'sp-t1', 1, 1)`
    )
      .bind(crypto.randomUUID())
      .run();

    const { body } = await call('/api/me/playlist-sync/disable', await cookieFor('u1'), 'POST');

    expect(body.enabled).toBe(false);
    // Songs already in the playlist are the user's -- disabling stops future
    // writes, it does not retract anything.
    expect(body.syncedCount).toBe(1);
    // And the Spotify grant itself is untouched, so re-enabling is one tap.
    expect(body.connected).toBe(true);
  });

  it('is idempotent when sync was never on', async () => {
    const { status, body } = await call('/api/me/playlist-sync/disable', await cookieFor('u1'), 'POST');

    expect(status).toBe(200);
    expect(body.enabled).toBe(false);
  });
});

describe('POST /api/me/playlist-sync/run', () => {
  it('requires a session', async () => {
    expect((await call('/api/me/playlist-sync/run', undefined, 'POST')).status).toBe(401);
  });

  it('skips without calling Spotify when sync is off', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('must not call Spotify'); });
    vi.stubGlobal('fetch', fetchMock);

    const { body } = await call('/api/me/playlist-sync/run', await cookieFor('u1'), 'POST');

    expect(body.added).toBe(0);
    expect(body.skipped).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when the flag is on but the write scope is missing', async () => {
    await setSyncEnabled(env.DB, 'u1', true, 1000);
    const fetchMock = vi.fn(async () => { throw new Error('must not call Spotify'); });
    vi.stubGlobal('fetch', fetchMock);

    const { body } = await call('/api/me/playlist-sync/run', await cookieFor('u1'), 'POST');

    expect(body.skipped).toBe('scope_missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the refreshed status alongside the result', async () => {
    const { body } = await call('/api/me/playlist-sync/run', await cookieFor('u1'), 'POST');

    expect(body.status).toEqual({
      enabled: false,
      connected: false,
      playlistUrl: null,
      lastSyncedAt: null,
      pendingCount: 0,
      syncedCount: 0,
      needsReconnect: false,
    });
  });
});
