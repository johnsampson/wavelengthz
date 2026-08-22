import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { encrypt } from '../../src/lib/crypto';
import { insertTestUser } from '../helpers/createUser';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  // music_profiles and sessions both FK-reference users(id), so they must be
  // cleared before users to avoid a foreign key constraint violation.
  await env.DB.exec(
    'DELETE FROM sessions; DELETE FROM music_profiles; DELETE FROM user_photos; DELETE FROM music_swipes; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
});

describe('GET /api/me', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/me'), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('returns the user and pulls a music profile on first call', async () => {
    const encToken = await encrypt('access-tok', env.TOKEN_ENCRYPTION_KEY);
    await insertTestUser(env.DB, {
      id: 'u1', spotifyId: 'sp1', accessToken: encToken, refreshToken: encToken,
      tokenExpiresAt: Date.now() + 100000, createdAt: 1000, updatedAt: 1000,
      avatarUrl: 'https://img.example/avatar.jpg',
    });
    const { cookie } = await createSession(env.DB, 'u1');
    const sessionId = cookie.split(';')[0].split('=')[1];

    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('top/artists')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'a1', name: 'Artist One', genres: ['pop'], images: [{ url: 'https://img.example/a1.jpg' }] }] }),
          { status: 200 }
        );
      }
      if (url.includes('top/tracks')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 't1',
                name: 'Track One',
                artists: [{ name: 'Track Artist' }],
                album: { images: [{ url: 'https://img.example/t1.jpg' }] },
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const req = new Request('http://localhost/api/me', { headers: { Cookie: `wl_session=${sessionId}` } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.user.id).toBe('u1');
    expect(body.user.spotify_avatar_url).toBe('https://img.example/avatar.jpg');
    expect(body.musicProfile.top_artists).toContain('a1');

    // Regression (issue #72): "Top artists on Spotify. Looks like that's
    // pulling recent listens" -- medium_term (~6 months) reads as recent
    // listening, not real top-artist identity. long_term is Spotify's
    // several-years affinity signal, the actual "top artists" semantics.
    const artistsCallUrl = fetchMock.mock.calls.find((c) => c[0].toString().includes('top/artists'))![0].toString();
    const tracksCallUrl = fetchMock.mock.calls.find((c) => c[0].toString().includes('top/tracks'))![0].toString();
    expect(artistsCallUrl).toContain('time_range=long_term');
    expect(tracksCallUrl).toContain('time_range=long_term');

    const row = await env.DB.prepare('SELECT * FROM music_profiles WHERE user_id = ?').bind('u1').first<any>();
    expect(row).toBeTruthy();
    expect(row.time_range).toBe('long_term');
    const topArtists = JSON.parse(row.top_artists);
    expect(topArtists[0]).toEqual({ artist_id: 'a1', rank: 1, name: 'Artist One', imageUrl: 'https://img.example/a1.jpg' });
    const topTracks = JSON.parse(row.top_tracks);
    expect(topTracks[0]).toEqual({ track_id: 't1', rank: 1, name: 'Track One', artistName: 'Track Artist', imageUrl: 'https://img.example/t1.jpg' });

    vi.unstubAllGlobals();
  });

  it('does not throw when a concurrent request wins the music_profiles insert race', async () => {
    const encToken = await encrypt('access-tok', env.TOKEN_ENCRYPTION_KEY);
    await insertTestUser(env.DB, {
      id: 'u2', spotifyId: 'sp2', accessToken: encToken, refreshToken: encToken,
      tokenExpiresAt: Date.now() + 100000, createdAt: 1000, updatedAt: 1000,
    });
    const { cookie } = await createSession(env.DB, 'u2');
    const sessionId = cookie.split(';')[0].split('=')[1];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('top/artists')) {
          return new Response(JSON.stringify({ items: [{ id: 'a2', name: 'Artist Two', genres: ['rock'] }] }), { status: 200 });
        }
        if (url.includes('top/tracks')) {
          return new Response(JSON.stringify({ items: [{ id: 't2', name: 'Track Two' }] }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const realDb = env.DB;
    let racedAlready = false;

    // Simulates a second concurrent /api/me request winning the race: right before
    // our own INSERT executes, another row for the same user_id lands in the table
    // (as if a concurrent request's INSERT completed first). With plain INSERT this
    // would throw a primary-key violation; with INSERT OR IGNORE it should not.
    const racyDb = {
      prepare: (sql: string) => {
        const real = realDb.prepare(sql);
        if (sql.includes('INTO music_profiles') && !racedAlready) {
          racedAlready = true;
          return {
            bind: (...args: unknown[]) => {
              const boundReal = real.bind(...args);
              return {
                run: async () => {
                  const racingNow = Date.now();
                  // args[1] is user_id -- matches src/routes/me.ts's own bind
                  // order (id, user_id, ...), since this intercepts and
                  // mirrors that exact INSERT.
                  await realDb
                    .prepare(
                      `INSERT INTO music_profiles (id, user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at, created_at, updated_at)
                       VALUES (?, ?, '[]', '[]', '[]', 'medium_term', ?, ?, ?)`
                    )
                    .bind(crypto.randomUUID(), args[1], racingNow, racingNow, racingNow)
                    .run();
                  return boundReal.run();
                },
              };
            },
          };
        }
        return real;
      },
    } as unknown as D1Database;

    const racyEnv = { ...env, DB: racyDb };

    const req = new Request('http://localhost/api/me', { headers: { Cookie: `wl_session=${sessionId}` } });
    const res = await worker.fetch(req, racyEnv, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.user.id).toBe('u2');
    expect(body.musicProfile.top_artists).toContain('a2');

    const rows = await realDb.prepare('SELECT * FROM music_profiles WHERE user_id = ?').bind('u2').all();
    expect(rows.results.length).toBe(1);

    vi.unstubAllGlobals();
  });

  // Regression test for a Task 4 code-review finding that was deferred to Task 18:
  // an uncaught Spotify API failure inside /api/me previously propagated as a raw
  // exception instead of a graceful error response. Task 18 added a global
  // try/catch around routing (src/index.ts) that should now convert this into a
  // clean 500 with no internal error details leaked into the response body.
  it('returns a clean 500 with no leaked error details when the Spotify API call throws', async () => {
    const encToken = await encrypt('access-tok', env.TOKEN_ENCRYPTION_KEY);
    await insertTestUser(env.DB, {
      id: 'u3', spotifyId: 'sp3', accessToken: encToken, refreshToken: encToken,
      tokenExpiresAt: Date.now() + 100000, createdAt: 1000, updatedAt: 1000,
    });
    const { cookie } = await createSession(env.DB, 'u3');
    const sessionId = cookie.split(';')[0].split('=')[1];

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Spotify API is down, secret=abc123');
      })
    );

    const req = new Request('http://localhost/api/me', {
      headers: { Cookie: `wl_session=${sessionId}`, 'CF-Connecting-IP': '5.5.5.5' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('Spotify API is down');
    expect(text).not.toContain('secret=abc123');

    vi.unstubAllGlobals();
  });

  // Regression: Spotify's top/artists response can include artist objects with
  // no `genres` field at all (not even an empty array) -- observed against the
  // real API, not just a documentation assumption. The genre-ranking loop in
  // this route did `for (const genre of artist.genres)` and crashed with
  // "artist.genres is not iterable" the first time that happened.
  it('does not throw when Spotify returns an artist with no genres field', async () => {
    const encToken = await encrypt('access-tok', env.TOKEN_ENCRYPTION_KEY);
    await insertTestUser(env.DB, {
      id: 'u4', spotifyId: 'sp4', accessToken: encToken, refreshToken: encToken,
      tokenExpiresAt: Date.now() + 100000, createdAt: 1000, updatedAt: 1000,
    });
    const { cookie } = await createSession(env.DB, 'u4');
    const sessionId = cookie.split(';')[0].split('=')[1];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('top/artists')) {
          return new Response(JSON.stringify({ items: [{ id: 'a4', name: 'Artist Four' }] }), { status: 200 });
        }
        if (url.includes('top/tracks')) {
          return new Response(JSON.stringify({ items: [{ id: 't4', name: 'Track Four' }] }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const req = new Request('http://localhost/api/me', { headers: { Cookie: `wl_session=${sessionId}` } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.musicProfile.top_genres).toBe('[]');

    vi.unstubAllGlobals();
  });

  it('returns hasSpotify: false and musicProfile: null for a user with no linked Spotify account, without calling getValidAccessToken', async () => {
    await insertTestUser(env.DB, { id: 'u5', skipSpotify: true });
    const { cookie } = await createSession(env.DB, 'u5');
    const sessionId = cookie.split(';')[0].split('=')[1];

    const fetchMock = vi.fn(async () => {
      throw new Error('should not call Spotify for a user with no linked account');
    });
    vi.stubGlobal('fetch', fetchMock);

    const req = new Request('http://localhost/api/me', { headers: { Cookie: `wl_session=${sessionId}` } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.hasSpotify).toBe(false);
    expect(body.musicProfile).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('returns hasSpotify: true for a user with a linked Spotify account', async () => {
    const encToken = await encrypt('access-tok', env.TOKEN_ENCRYPTION_KEY);
    await insertTestUser(env.DB, {
      id: 'u6', spotifyId: 'sp6', accessToken: encToken, refreshToken: encToken,
      tokenExpiresAt: Date.now() + 100000, createdAt: 1000, updatedAt: 1000,
    });
    const { cookie } = await createSession(env.DB, 'u6');
    const sessionId = cookie.split(';')[0].split('=')[1];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('top/artists')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
        if (url.includes('top/tracks')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const req = new Request('http://localhost/api/me', { headers: { Cookie: `wl_session=${sessionId}` } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.hasSpotify).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe('POST /api/me/anthem', () => {
  async function makeUserWithTopTracks() {
    const encToken = await encrypt('access-tok', env.TOKEN_ENCRYPTION_KEY);
    await insertTestUser(env.DB, {
      id: 'u5', spotifyId: 'sp5', accessToken: encToken, refreshToken: encToken,
      tokenExpiresAt: Date.now() + 100000, createdAt: 1000, updatedAt: 1000,
    });
    const topTracks = JSON.stringify([{ track_id: 't1', rank: 1, name: 'My Track', imageUrl: null }]);
    await env.DB.prepare(
      `INSERT INTO music_profiles (id, user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at, created_at, updated_at) VALUES ('mp14', 'u5', '[]', ?, '[]', 'medium_term', 1000, 1000, 1000)`
    ).bind(topTracks).run();
    const { cookie } = await createSession(env.DB, 'u5');
    return cookie.split(';')[0].split('=')[1];
  }

  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/me/anthem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackId: 't1' }) }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it('sets the anthem when trackId is one of the caller\'s own top tracks', async () => {
    const sessionId = await makeUserWithTopTracks();
    const res = await worker.fetch(
      new Request('http://localhost/api/me/anthem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `wl_session=${sessionId}` },
        body: JSON.stringify({ trackId: 't1' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT anthem_track_id FROM users WHERE id = ?').bind('u5').first<any>();
    expect(row.anthem_track_id).toBe('t1');
  });

  it('rejects a trackId that is not one of the caller\'s own top tracks', async () => {
    const sessionId = await makeUserWithTopTracks();
    const res = await worker.fetch(
      new Request('http://localhost/api/me/anthem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `wl_session=${sessionId}` },
        body: JSON.stringify({ trackId: 'someone-elses-track' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);

    const row = await env.DB.prepare('SELECT anthem_track_id FROM users WHERE id = ?').bind('u5').first<any>();
    expect(row.anthem_track_id).toBeNull();
  });

  it('clears the anthem when trackId is null', async () => {
    const sessionId = await makeUserWithTopTracks();
    await env.DB.prepare('UPDATE users SET anthem_track_id = ? WHERE id = ?').bind('t1', 'u5').run();

    const res = await worker.fetch(
      new Request('http://localhost/api/me/anthem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `wl_session=${sessionId}` },
        body: JSON.stringify({ trackId: null }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT anthem_track_id FROM users WHERE id = ?').bind('u5').first<any>();
    expect(row.anthem_track_id).toBeNull();
  });
});

describe('POST /api/me/email-notifications', () => {
  async function makeUser() {
    await insertTestUser(env.DB, { id: 'u6', spotifyId: 'sp6', createdAt: 1000, updatedAt: 1000 });
    const { cookie } = await createSession(env.DB, 'u6');
    return cookie.split(';')[0].split('=')[1];
  }

  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/me/email-notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it('is enabled by default -- matches the notification-sending behavior every existing row already has', async () => {
    await insertTestUser(env.DB, { id: 'u6', spotifyId: 'sp6', createdAt: 1000, updatedAt: 1000 });
    const row = await env.DB.prepare('SELECT email_notifications_enabled FROM users WHERE id = ?').bind('u6').first<any>();
    expect(row.email_notifications_enabled).toBe(1);
  });

  it('disables email notifications', async () => {
    const sessionId = await makeUser();
    const res = await worker.fetch(
      new Request('http://localhost/api/me/email-notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `wl_session=${sessionId}` },
        body: JSON.stringify({ enabled: false }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT email_notifications_enabled FROM users WHERE id = ?').bind('u6').first<any>();
    expect(row.email_notifications_enabled).toBe(0);
  });

  it('re-enables email notifications', async () => {
    const sessionId = await makeUser();
    await env.DB.prepare('UPDATE users SET email_notifications_enabled = 0 WHERE id = ?').bind('u6').run();

    const res = await worker.fetch(
      new Request('http://localhost/api/me/email-notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `wl_session=${sessionId}` },
        body: JSON.stringify({ enabled: true }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT email_notifications_enabled FROM users WHERE id = ?').bind('u6').first<any>();
    expect(row.email_notifications_enabled).toBe(1);
  });

  it('rejects a non-boolean enabled value, writing nothing', async () => {
    const sessionId = await makeUser();
    const res = await worker.fetch(
      new Request('http://localhost/api/me/email-notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `wl_session=${sessionId}` },
        body: JSON.stringify({ enabled: 'yes' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);

    const row = await env.DB.prepare('SELECT email_notifications_enabled FROM users WHERE id = ?').bind('u6').first<any>();
    expect(row.email_notifications_enabled).toBe(1);
  });
});

describe('GET /api/me/messaging-status', () => {
  async function makeUser(overrides: Record<string, unknown> = {}) {
    await insertTestUser(env.DB, { id: 'u7', spotifyId: 'sp7', createdAt: 1000, updatedAt: 1000, ...overrides });
    const { cookie } = await createSession(env.DB, 'u7');
    return cookie.split(';')[0].split('=')[1];
  }

  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/me/messaging-status'), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('reports every requirement unmet, with real thresholds and zero counts, for a bare-minimum account', async () => {
    const sessionId = await makeUser();
    const res = await worker.fetch(
      new Request('http://localhost/api/me/messaging-status', { headers: { Cookie: `wl_session=${sessionId}` } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const body = await res.json<any>();

    expect(body.ready).toBe(false);
    expect(body.bio).toEqual({ met: false, length: 0, required: 20 });
    expect(body.photos).toEqual({ met: false, count: 0, required: 3 });
    expect(body.likedSongs).toEqual({ met: false, count: 0, required: 25 });
    expect(body.phone).toEqual({ met: false, phoneNumber: null });
  });

  it('reports ready: true and every requirement met once all four are satisfied', async () => {
    const sessionId = await makeUser({
      bio: 'A bio long enough to pass the profile-completeness gate.',
      phoneNumber: '+15551234567',
      phoneVerifiedAt: 1000,
    });
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        `INSERT INTO user_photos (id, user_id, r2_key, position, created_at, updated_at) VALUES (?, 'u7', ?, ?, 1000, 1000)`
      )
        .bind(`photo-${i}`, `users/u7/photo${i}.jpg`, i)
        .run();
    }
    for (let i = 0; i < 25; i++) {
      await env.DB.prepare(
        `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES (?, 'u7', 'track', ?, 'right', 1000, 1000)`
      )
        .bind(`swipe-${i}`, `track-${i}`)
        .run();
    }

    const res = await worker.fetch(
      new Request('http://localhost/api/me/messaging-status', { headers: { Cookie: `wl_session=${sessionId}` } }),
      env,
      {} as ExecutionContext
    );
    const body = await res.json<any>();

    expect(body.ready).toBe(true);
    expect(body.bio.met).toBe(true);
    expect(body.photos).toEqual({ met: true, count: 3, required: 3 });
    expect(body.likedSongs).toEqual({ met: true, count: 25, required: 25 });
    expect(body.phone).toEqual({ met: true, phoneNumber: '+15551234567' });
  });

  it('is not ready when every requirement but one is met -- reports the specific gap', async () => {
    const sessionId = await makeUser({
      bio: 'A bio long enough to pass the profile-completeness gate.',
      phoneNumber: null,
      phoneVerifiedAt: null,
    });
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        `INSERT INTO user_photos (id, user_id, r2_key, position, created_at, updated_at) VALUES (?, 'u7', ?, ?, 1000, 1000)`
      )
        .bind(`photo-${i}`, `users/u7/photo${i}.jpg`, i)
        .run();
    }
    for (let i = 0; i < 25; i++) {
      await env.DB.prepare(
        `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES (?, 'u7', 'track', ?, 'right', 1000, 1000)`
      )
        .bind(`swipe-${i}`, `track-${i}`)
        .run();
    }

    const res = await worker.fetch(
      new Request('http://localhost/api/me/messaging-status', { headers: { Cookie: `wl_session=${sessionId}` } }),
      env,
      {} as ExecutionContext
    );
    const body = await res.json<any>();

    expect(body.ready).toBe(false);
    expect(body.bio.met).toBe(true);
    expect(body.photos.met).toBe(true);
    expect(body.likedSongs.met).toBe(true);
    expect(body.phone).toEqual({ met: false, phoneNumber: null });
  });
});
