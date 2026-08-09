import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { encrypt } from '../../src/lib/crypto';
import { insertTestUser } from '../helpers/createUser';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

async function makeUserWithSpotify(id: string, { productTier, grantedScope }: { productTier: string | null; grantedScope: string | null }) {
  const encToken = await encrypt('access-tok', env.TOKEN_ENCRYPTION_KEY);
  await insertTestUser(env.DB, {
    id,
    spotifyId: `sp-${id}`,
    accessToken: encToken,
    refreshToken: encToken,
    tokenExpiresAt: Date.now() + 100000,
    createdAt: 1000,
    updatedAt: 1000,
    productTier,
  });
  await env.DB.prepare(`UPDATE music_source_tokens SET granted_scope = ? WHERE user_id = ?`).bind(grantedScope, id).run();
}

describe('GET /api/me/player-token', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/me/player-token'), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('is available for a Premium account already re-authorized with the streaming scope', async () => {
    await makeUserWithSpotify('u1', { productTier: 'premium', grantedScope: 'user-top-read streaming user-read-playback-state' });
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/me/player-token', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.available).toBe(true);
    expect(body.accessToken).toBe('access-tok');
  });

  it('is unavailable for a Free-tier account, even with the streaming scope granted', async () => {
    await makeUserWithSpotify('u2', { productTier: 'free', grantedScope: 'user-top-read streaming' });
    const cookie = await cookieFor('u2');

    const res = await worker.fetch(new Request('http://localhost/api/me/player-token', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.available).toBe(false);
    expect(body.accessToken).toBeUndefined();
  });

  it('is unavailable for a Premium account that has not re-authorized since the streaming scope was added', async () => {
    // granted_scope is null here -- the realistic state for every account
    // that logged in before migration 0008 added this column.
    await makeUserWithSpotify('u3', { productTier: 'premium', grantedScope: null });
    const cookie = await cookieFor('u3');

    const res = await worker.fetch(new Request('http://localhost/api/me/player-token', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.available).toBe(false);
  });

  it('is unavailable for a Premium account whose granted scope does not include streaming', async () => {
    await makeUserWithSpotify('u4', { productTier: 'premium', grantedScope: 'user-top-read user-read-email' });
    const cookie = await cookieFor('u4');

    const res = await worker.fetch(new Request('http://localhost/api/me/player-token', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.available).toBe(false);
  });

  it('is unavailable when the caller has no linked Spotify token row at all', async () => {
    await insertTestUser(env.DB, { id: 'u5', spotifyId: 'sp-u5', createdAt: 1000, updatedAt: 1000 });
    await env.DB.prepare(`DELETE FROM music_source_tokens WHERE user_id = 'u5'`).run();
    const cookie = await cookieFor('u5');

    const res = await worker.fetch(new Request('http://localhost/api/me/player-token', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.available).toBe(false);
  });
});
