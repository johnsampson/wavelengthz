import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import { setFollowSyncEnabled } from '../../src/lib/followSync';
import { FOLLOW_SYNC_SCOPE, PLAYLIST_SYNC_SCOPE } from '../../src/lib/spotify';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM spotify_follow_sync_items; DELETE FROM spotify_follow_syncs; DELETE FROM music_swipes; DELETE FROM artists; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
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

async function grantScope(scope: string) {
  await env.DB.prepare(`UPDATE music_source_tokens SET granted_scope = ? WHERE user_id = 'u1'`).bind(scope).run();
}

describe('GET /api/me/follow-sync', () => {
  it('requires a session', async () => {
    expect((await call('/api/me/follow-sync')).status).toBe(401);
  });

  it('reports off-and-unconnected for an account that never opted in', async () => {
    const { status, body } = await call('/api/me/follow-sync', await cookieFor('u1'));

    expect(status).toBe(200);
    expect(body).toEqual({ enabled: false, connected: false, lastSyncedAt: null, pendingCount: 0, followedCount: 0, needsReconnect: false });
  });

  it('does not treat the playlist grant as permission to follow', async () => {
    await grantScope(`streaming ${PLAYLIST_SYNC_SCOPE}`);

    expect((await call('/api/me/follow-sync', await cookieFor('u1'))).body.connected).toBe(false);
  });

  it('reports connected once the follow scope is actually granted', async () => {
    await grantScope(`streaming ${FOLLOW_SYNC_SCOPE}`);
    const { body } = await call('/api/me/follow-sync', await cookieFor('u1'));

    expect(body.connected).toBe(true);
    // Granting is not enabling.
    expect(body.enabled).toBe(false);
  });

  it('makes no Spotify call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('must not call Spotify'); }));
    expect((await call('/api/me/follow-sync', await cookieFor('u1'))).status).toBe(200);
  });
});

describe('POST /api/me/follow-sync/disable', () => {
  it('requires a session', async () => {
    expect((await call('/api/me/follow-sync/disable', undefined, 'POST')).status).toBe(401);
  });

  it('turns following off without unfollowing anyone', async () => {
    await grantScope(`streaming ${FOLLOW_SYNC_SCOPE}`);
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    await env.DB.prepare(
      `INSERT INTO spotify_follow_sync_items (id, user_id, spotify_artist_id, created_at, updated_at) VALUES (?, 'u1', 'sp-a1', 1, 1)`
    ).bind(crypto.randomUUID()).run();

    const { body } = await call('/api/me/follow-sync/disable', await cookieFor('u1'), 'POST');

    expect(body.enabled).toBe(false);
    // Those follows are the user's now -- silently undoing something visible
    // on their public profile would be worse than the original write.
    expect(body.followedCount).toBe(1);
    expect(body.connected).toBe(true);
  });
});

describe('POST /api/me/follow-sync/run', () => {
  it('requires a session', async () => {
    expect((await call('/api/me/follow-sync/run', undefined, 'POST')).status).toBe(401);
  });

  it('skips without calling Spotify when following is off', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('must not call Spotify'); });
    vi.stubGlobal('fetch', fetchMock);

    const { body } = await call('/api/me/follow-sync/run', await cookieFor('u1'), 'POST');

    expect(body.skipped).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when enabled but the scope is missing', async () => {
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
    const fetchMock = vi.fn(async () => { throw new Error('must not call Spotify'); });
    vi.stubGlobal('fetch', fetchMock);

    expect((await call('/api/me/follow-sync/run', await cookieFor('u1'), 'POST')).body.skipped).toBe('scope_missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the refreshed status alongside the result', async () => {
    const { body } = await call('/api/me/follow-sync/run', await cookieFor('u1'), 'POST');

    expect(body.status).toEqual({ enabled: false, connected: false, lastSyncedAt: null, pendingCount: 0, followedCount: 0, needsReconnect: false });
  });
});
