import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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

describe('GET /api/me/now-playing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubNowPlaying(status: number, payload?: any) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('/v1/me/player/currently-playing')) {
          return status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(payload), { status });
        }
        throw new Error(`unexpected ${url}`);
      })
    );
  }

  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/me/now-playing'), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('returns the current track in a shareable shape', async () => {
    await makeUserWithSpotify('u1', { productTier: 'premium', grantedScope: 'user-read-playback-state' });
    const cookie = await cookieFor('u1');
    stubNowPlaying(200, {
      item: {
        type: 'track',
        id: 'sp-t1',
        name: 'Landslide',
        artists: [{ id: 'sp-a', name: 'Fleetwood Mac' }],
        album: { images: [{ url: 'https://i/t1.jpg' }] },
        preview_url: null,
      },
    });

    const res = await worker.fetch(new Request('http://localhost/api/me/now-playing', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.playing).toEqual({
      spotifyTrackId: 'sp-t1',
      name: 'Landslide',
      artistName: 'Fleetwood Mac',
      imageUrl: 'https://i/t1.jpg',
    });
    // The raw object rides along so the share call can resolve it into the
    // catalog with no follow-up Spotify request.
    expect(body.track.artists[0].id).toBe('sp-a');
  });

  it('reports nothing playing on a 204, rather than erroring', async () => {
    await makeUserWithSpotify('u1', { productTier: 'premium', grantedScope: 'user-read-playback-state' });
    const cookie = await cookieFor('u1');
    stubNowPlaying(204);

    const res = await worker.fetch(new Request('http://localhost/api/me/now-playing', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect((await res.json<any>()).playing).toBeNull();
  });

  it('ignores a podcast episode -- only tracks belong in a music thread', async () => {
    await makeUserWithSpotify('u1', { productTier: 'premium', grantedScope: 'user-read-playback-state' });
    const cookie = await cookieFor('u1');
    stubNowPlaying(200, { item: { type: 'episode', id: 'ep-1', name: 'Some Podcast' } });

    const res = await worker.fetch(new Request('http://localhost/api/me/now-playing', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect((await res.json<any>()).playing).toBeNull();
  });

  it('degrades to nothing-playing when the user has no Spotify connection at all', async () => {
    await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp-u2', createdAt: 1000, updatedAt: 1000 });
    const cookie = await cookieFor('u2');

    const res = await worker.fetch(new Request('http://localhost/api/me/now-playing', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect((await res.json<any>()).playing).toBeNull();
  });

  it('degrades to nothing-playing on a Spotify failure rather than surfacing an error', async () => {
    await makeUserWithSpotify('u1', { productTier: 'premium', grantedScope: 'user-read-playback-state' });
    const cookie = await cookieFor('u1');
    stubNowPlaying(500, {});

    const res = await worker.fetch(new Request('http://localhost/api/me/now-playing', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect((await res.json<any>()).playing).toBeNull();
  });
});
