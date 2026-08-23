import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import { genresToObject } from '../../src/lib/genres';
import { encrypt } from '../../src/lib/crypto';
import { FOLLOW_SYNC_SCOPE } from '../../src/lib/spotify';
import { setFollowSyncEnabled } from '../../src/lib/followSync';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM user_blocked_genres; DELETE FROM user_genres; DELETE FROM spotify_follow_sync_items; DELETE FROM spotify_follow_syncs; DELETE FROM music_swipes; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM sessions; DELETE FROM tracks; DELETE FROM users; DELETE FROM artists;'
  );
  // SWIPE_LIMIT (src/index.ts) is a real 30-per-60s cap, keyed by IP -- test
  // requests all share the same fallback 'unknown' IP, so without this a
  // test file with enough /api/swipe/music calls across its tests silently
  // starts getting 429'd partway through (tests that only check DB state
  // afterward, not response.status, see it as "nothing happened").
  const rateLimitKeys = await env.RATE_LIMIT_KV.list();
  await Promise.all(rateLimitKeys.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
  await insertTestUser(env.DB, {
    id: 'u1',
    spotifyId: 'sp1',
    accessToken: 'a',
    refreshToken: 'r',
    tokenExpiresAt: 9999999999999,
    createdAt: 1000,
    updatedAt: 1000,
  });
  await env.DB.prepare(
    `INSERT INTO artists (id, name, genres, image_url, source, approved, created_at) VALUES ('a1', 'Artist One', '{}', 'https://img.example/a1.jpg', 'seed', 1, 1000)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO artists (id, name, genres, image_url, source, approved, created_at) VALUES ('a2', 'Artist Two', '{}', 'https://img.example/a2.jpg', 'seed', 1, 1000)`
  ).run();
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

// GET /api/candidates/music now calls ctx.waitUntil for the background
// artist top-up (src/routes/musicSwipes.ts), so a bare `{}` throws
// "ctx.waitUntil is not a function". This no-op stands in for real routes
// that don't care about the background work's outcome; the one test that
// does care builds its own ctx that captures the promise instead.
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

describe('GET /api/candidates/music', () => {
  it('excludes artists the user has already swiped on', async () => {
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'right', 1000, 1000)`
    ).run();
    const req = new Request('http://localhost/api/candidates/music', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();
    expect(body.candidates.map((c: any) => c.itemId)).toEqual(['a2']);
  });

  it('excludes artists with no photo', async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('a3', 'No Photo Artist', '{}', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?limit=10', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();
    expect(body.candidates.map((c: any) => c.itemId)).not.toContain('a3');
  });

  it('excludes an artist carrying a genre the user has blocked', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['country', 'pop']))).run();
    await env.DB.prepare(
      `INSERT INTO user_blocked_genres (id, user_id, genre, created_at, updated_at) VALUES ('bg1', 'u1', 'country', 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    const req = new Request('http://localhost/api/candidates/music?limit=10', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();

    expect(body.candidates.map((c: any) => c.itemId)).not.toContain('a1');
    expect(body.candidates.map((c: any) => c.itemId)).toContain('a2'); // a2 has no genres, unaffected
  });

  it('excludes a track whose parent artist carries a blocked genre', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['country']))).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, album_image_url, source, approved, created_at) VALUES ('t1', 'Track One', 'a1', 'https://img.example/t1.jpg', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_blocked_genres (id, user_id, genre, created_at, updated_at) VALUES ('bg1', 'u1', 'country', 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    const req = new Request('http://localhost/api/candidates/music?item_type=track', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();

    expect(body.candidates.map((c: any) => c.itemId)).not.toContain('t1');
  });

  it('includes each artist\'s image URL', async () => {
    await env.DB.prepare(`UPDATE artists SET image_url = 'https://img.example/a1.jpg' WHERE id = 'a1'`).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?limit=1', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();
    expect(body.candidates[0].imageUrl).toBe('https://img.example/a1.jpg');
  });

  it('includes each track\'s album image URL when browsing tracks', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, album_image_url, source, approved, created_at)
       VALUES ('t1', 'Track One', 'a1', 'https://img.example/t1.jpg', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?item_type=track', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();
    expect(body.candidates[0].imageUrl).toBe('https://img.example/t1.jpg');
  });

  // public/index.html's deck card renders these in the same chip row
  // people-mode candidates already use for their own topGenres.
  it('includes an artist candidate\'s genres as topGenres', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['indie', 'rock']))).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?limit=10', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();
    const a1 = body.candidates.find((c: any) => c.itemId === 'a1');
    expect(a1.topGenres).toEqual(['indie', 'rock']);
  });

  it('caps topGenres at 5 for an artist with many genres', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`)
      .bind(JSON.stringify(genresToObject(['a', 'b', 'c', 'd', 'e', 'f', 'g'])))
      .run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?limit=10', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();
    const a1 = body.candidates.find((c: any) => c.itemId === 'a1');
    expect(a1.topGenres).toHaveLength(5);
  });

  it('reports no genres as an empty array, not null or undefined', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?limit=10', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();
    const a2 = body.candidates.find((c: any) => c.itemId === 'a2'); // a2 has genres: '{}' from beforeEach
    expect(a2.topGenres).toEqual([]);
  });

  it('includes a track candidate\'s parent artist\'s genres as topGenres', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['jazz']))).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, album_image_url, source, approved, created_at)
       VALUES ('t1', 'Track One', 'a1', 'https://img.example/t1.jpg', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?item_type=track', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();
    expect(body.candidates[0].topGenres).toEqual(['jazz']);
  });

  it('includes a representative track for an artist candidate, when one already exists in the catalog', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, album_image_url, duration_ms, source, approved, created_at) VALUES ('t1', 'sp-t1', 'Track One', 'a1', 'https://img.example/t1.jpg', 180000, 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?limit=10', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();
    const a1 = body.candidates.find((c: any) => c.itemId === 'a1');
    // durationMs rides along so the player can start at the hook (migrations/0022).
    expect(a1.track).toEqual({ id: 't1', spotifyId: 'sp-t1', name: 'Track One', imageUrl: 'https://img.example/t1.jpg', durationMs: 180000 });
  });

  it('reports track: null for an artist candidate with no cataloged tracks', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?limit=10', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();
    const a1 = body.candidates.find((c: any) => c.itemId === 'a1');
    expect(a1.track).toBeNull();
  });

  it('picks the earliest-inserted track as the representative one when an artist has more than one', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, album_image_url, source, approved, created_at) VALUES ('t1', 'sp-t1', 'First Track', 'a1', 'https://img.example/t1.jpg', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, album_image_url, source, approved, created_at) VALUES ('t2', 'sp-t2', 'Second Track', 'a1', 'https://img.example/t2.jpg', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?limit=10', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();
    const a1 = body.candidates.find((c: any) => c.itemId === 'a1');
    expect(a1.track.id).toBe('t1');
  });

  it('omits track info for track-type candidates -- the preview feature is artist-mode only', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, album_image_url, source, approved, created_at) VALUES ('t1', 'sp-t1', 'Track One', 'a1', 'https://img.example/t1.jpg', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?item_type=track', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();
    expect(body.candidates[0].track).toBeNull();
  });

  it('tops up the catalog from Spotify and returns fresh candidates once the local pool is exhausted', async () => {
    // Exhaust both seeded artists.
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s2', 'u1', 'artist', 'a2', 'left', 1000, 1000)`
    ).run();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('type=artist')) {
          return new Response(
            JSON.stringify({ artists: { items: [{ id: 'fresh1', name: 'Fresh Artist', genres: ['pop'], images: [{ url: 'https://img.example/fresh1.jpg' }], popularity: 50 }] } }),
            { status: 200 }
          );
        }
        if (url.includes('/albums')) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();

    // itemId is now the internal UUID, not the Spotify id -- resolve it via
    // spotify_id first, then confirm it showed up as a candidate.
    const row = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('fresh1').first<any>();
    expect(row).toBeTruthy();
    expect(body.candidates.map((c: any) => c.itemId)).toContain(row.id);

    vi.unstubAllGlobals();
  });

  it('tops up in the background (ctx.waitUntil) once the pool is low but not yet empty, without delaying the response', async () => {
    // Seed up to 16 total artists (a1/a2 from beforeEach + 14 more), then
    // swipe all but one -- 1 remaining is well under LOW_ARTIST_POOL_THRESHOLD
    // (15), but not zero, so this should hit the background path, not the
    // synchronous one.
    for (let i = 0; i < 14; i++) {
      await env.DB.prepare(
        `INSERT INTO artists (id, name, genres, image_url, source, approved, created_at) VALUES (?, ?, '{}', ?, 'seed', 1, 1000)`
      ).bind(`extra${i}`, `Extra ${i}`, `https://img.example/extra${i}.jpg`).run();
    }
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'right', 1000, 1000)`
    ).run();
    for (let i = 0; i < 14; i++) {
      await env.DB.prepare(
        `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES (?, 'u1', 'artist', ?, 'right', 1000, 1000)`
      ).bind(`s-extra${i}`, `extra${i}`).run();
    }
    // Only 'a2' remains unswiped.

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('type=artist')) {
          return new Response(
            JSON.stringify({ artists: { items: [{ id: 'bg-fresh', name: 'Background Fresh Artist', genres: ['pop'], images: [{ url: 'https://img.example/bg-fresh.jpg' }], popularity: 50 }] } }),
            { status: 200 }
          );
        }
        if (url.includes('/albums')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
        throw new Error(`unexpected ${url}`);
      })
    );

    const pending: Promise<any>[] = [];
    const capturingCtx = { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext;

    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?limit=50', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, capturingCtx);
    const body = await res.json<any>();

    // Response comes back immediately with what's already there -- no
    // 'bg-fresh' yet, since the top-up hasn't been awaited.
    expect(body.candidates.map((c: any) => c.itemId)).toEqual(['a2']);
    expect(pending.length).toBe(1); // background top-up was scheduled, not awaited inline

    await Promise.all(pending);

    const row = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('bg-fresh').first<any>();
    expect(row).toBeTruthy(); // ...but it's there once the background work finishes

    vi.unstubAllGlobals();
  });

  it('does not top up when browsing tracks, only artists', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch should not be called for track candidates');
    });
    vi.stubGlobal('fetch', fetchMock);

    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/music?item_type=track', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('excludes a live recording from track candidates (issue #108)', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, album_image_url, source, approved, created_at) VALUES ('t1', 'Track One', 'a1', 'https://img.example/t1.jpg', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, album_image_url, source, approved, created_at) VALUES ('t2', 'Track One - Live', 'a1', 'https://img.example/t2.jpg', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    const req = new Request('http://localhost/api/candidates/music?item_type=track&limit=10', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();

    expect(body.candidates.map((c: any) => c.itemId)).toContain('t1');
    expect(body.candidates.map((c: any) => c.itemId)).not.toContain('t2');
  });

  it('does not filter artist candidates by their own name matching the live pattern', async () => {
    // ${table}.name in the underlying query is the ARTIST's name for artist
    // candidates -- the live-recording heuristic has no business examining
    // it. An artist whose name would trip the heuristic if it were wrongly
    // applied here must still come through untouched.
    await env.DB.prepare(
      `INSERT INTO artists (id, name, genres, image_url, source, approved, created_at) VALUES ('a4', 'The Band - Live', '{}', 'https://img.example/a4.jpg', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    const req = new Request('http://localhost/api/candidates/music?limit=10', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json<any>();

    expect(body.candidates.map((c: any) => c.itemId)).toContain('a4');
  });
});

describe('POST /api/swipe/music', () => {
  it('creates a swipe and upserts direction on repeat swipe', async () => {
    const cookie = await cookieFor('u1');
    const swipe = (direction: string) =>
      worker.fetch(
        new Request('http://localhost/api/swipe/music', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_type: 'artist', item_id: 'a1', direction }),
        }),
        env,
        ctx
      );

    await swipe('left');
    let row = await env.DB.prepare('SELECT * FROM music_swipes WHERE user_id = ? AND item_id = ?').bind('u1', 'a1').first<any>();
    expect(row.direction).toBe('left');

    await swipe('right');
    const rows = await env.DB.prepare('SELECT * FROM music_swipes WHERE user_id = ? AND item_id = ?').bind('u1', 'a1').all<any>();
    expect(rows.results.length).toBe(1); // upsert, not a second row
    expect(rows.results[0].direction).toBe('right');
  });

  it('rejects an invalid direction, writing nothing', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/swipe/music', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: 'artist', item_id: 'a1', direction: 'up' }),
      }),
      env,
      ctx
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_direction');
    const row = await env.DB.prepare('SELECT * FROM music_swipes WHERE user_id = ? AND item_id = ?').bind('u1', 'a1').first<any>();
    expect(row).toBeNull();
  });

  it('accepts "skip" as a real direction (issue: no reason to pass on an artist you do not recognize)', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/swipe/music', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: 'artist', item_id: 'a1', direction: 'skip' }),
      }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT direction FROM music_swipes WHERE user_id = ? AND item_id = ?').bind('u1', 'a1').first<any>();
    expect(row.direction).toBe('skip');
  });

  it('skip removes the artist from the candidate pool, same as a real left/right swipe', async () => {
    const cookie = await cookieFor('u1');
    await worker.fetch(
      new Request('http://localhost/api/swipe/music', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: 'artist', item_id: 'a1', direction: 'skip' }),
      }),
      env,
      ctx
    );

    const res = await worker.fetch(new Request('http://localhost/api/candidates/music', { headers: { Cookie: cookie } }), env, ctx);
    const body = await res.json<any>();
    expect(body.candidates.some((c: any) => c.itemId === 'a1')).toBe(false);
  });
});

describe('real-time follow sync on like (issue: "should happen on every like action around the site")', () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, image_url, source, approved, created_at) VALUES ('fa1', 'sp-fa1', 'Follow Artist', '{}', 'https://img.example/fa1.jpg', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, album_image_url, source, approved, created_at) VALUES ('ft1', 'sp-ft1', 'Follow Track', 'fa1', 'https://img.example/ft1.jpg', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(`UPDATE music_source_tokens SET access_token = ?, refresh_token = ?, granted_scope = ? WHERE user_id = 'u1'`)
      .bind(
        await encrypt('live-access-token', env.TOKEN_ENCRYPTION_KEY),
        await encrypt('live-refresh-token', env.TOKEN_ENCRYPTION_KEY),
        `user-top-read streaming ${FOLLOW_SYNC_SCOPE}`
      )
      .run();
    await setFollowSyncEnabled(env.DB, 'u1', true, 1000);
  });

  /** Stubs only PUT /v1/me/following; anything else throws. */
  function stubFollowFetch() {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = input.toString();
        const method = init?.method ?? 'GET';
        calls.push({ url, method });
        if (url.includes('/me/following') && method === 'PUT') return new Response('', { status: 204 });
        throw new Error(`unexpected Spotify call: ${method} ${url}`);
      })
    );
    return calls;
  }

  it('follows the artist on Spotify in the background when liked directly, without delaying the response', async () => {
    const calls = stubFollowFetch();
    const pending: Promise<any>[] = [];
    const capturingCtx = { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext;
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(
      new Request('http://localhost/api/swipe/music', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: 'artist', item_id: 'fa1', direction: 'right' }),
      }),
      env,
      capturingCtx
    );
    expect(res.status).toBe(200);
    // Scheduled via ctx.waitUntil, not awaited inline -- the response above
    // already landed before the Spotify call below is made.
    expect(pending.length).toBe(1);
    expect(calls.filter((c) => c.url.includes('/me/following')).length).toBe(0);

    await Promise.all(pending);

    expect(calls.some((c) => c.url.includes('/me/following') && c.method === 'PUT')).toBe(true);
    const item = await env.DB
      .prepare('SELECT * FROM spotify_follow_sync_items WHERE user_id = ? AND spotify_artist_id = ?')
      .bind('u1', 'sp-fa1')
      .first<any>();
    expect(item).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it('follows the artist when liked via the track-like cascade', async () => {
    const calls = stubFollowFetch();
    const pending: Promise<any>[] = [];
    const capturingCtx = { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext;
    const cookie = await cookieFor('u1');

    await worker.fetch(
      new Request('http://localhost/api/swipe/music', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: 'track', item_id: 'ft1', direction: 'right' }),
      }),
      env,
      capturingCtx
    );
    await Promise.all(pending);

    expect(calls.some((c) => c.url.includes('/me/following') && c.method === 'PUT')).toBe(true);
    const item = await env.DB
      .prepare('SELECT * FROM spotify_follow_sync_items WHERE user_id = ? AND spotify_artist_id = ?')
      .bind('u1', 'sp-fa1')
      .first<any>();
    expect(item).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it('does not follow or unfollow anything on a left-swipe pass', async () => {
    const calls = stubFollowFetch();
    const pending: Promise<any>[] = [];
    const capturingCtx = { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext;
    const cookie = await cookieFor('u1');

    await worker.fetch(
      new Request('http://localhost/api/swipe/music', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: 'artist', item_id: 'fa1', direction: 'left' }),
      }),
      env,
      capturingCtx
    );
    await Promise.all(pending);

    expect(calls.filter((c) => c.url.includes('/me/following')).length).toBe(0);

    vi.unstubAllGlobals();
  });

  it('fires from the History "Change" toggle too (PATCH /api/swipes/music/:id)', async () => {
    const calls = stubFollowFetch();
    const pending: Promise<any>[] = [];
    const capturingCtx = { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext;
    const cookie = await cookieFor('u1');

    // Starts as a pass, then gets "Changed" to a like from History -- a
    // distinct code path from a fresh swipe.
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('sw1', 'u1', 'artist', 'fa1', 'left', 1000, 1000)`
    ).run();

    const res = await worker.fetch(
      new Request('http://localhost/api/swipes/music/sw1', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'right' }),
      }),
      env,
      capturingCtx
    );
    expect(res.status).toBe(200);
    await Promise.all(pending);

    expect(calls.some((c) => c.url.includes('/me/following') && c.method === 'PUT')).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe('skip and genre tracking', () => {
  async function affinityFor(userId: string, genre: string): Promise<number> {
    const row = await env.DB.prepare('SELECT (artist_count + track_count) as total FROM user_genres WHERE user_id = ? AND genre = ?')
      .bind(userId, genre)
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  async function passCountFor(userId: string, genre: string): Promise<number> {
    const row = await env.DB.prepare('SELECT pass_count FROM user_genres WHERE user_id = ? AND genre = ?').bind(userId, genre).first<{ pass_count: number }>();
    return row?.pass_count ?? 0;
  }

  it('skipping a fresh candidate touches neither genre affinity nor pass tracking', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['indie']))).run();
    const cookie = await cookieFor('u1');

    await worker.fetch(
      new Request('http://localhost/api/swipe/music', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: 'artist', item_id: 'a1', direction: 'skip' }),
      }),
      env,
      ctx
    );

    expect(await affinityFor('u1', 'indie')).toBe(0);
    expect(await passCountFor('u1', 'indie')).toBe(0);
  });

  it('undoes genre affinity if a right-swiped item is later changed to skip via PATCH', async () => {
    // Not reachable from today's History UI (public/history.js's toggle()
    // only ever sends 'left'/'right'), but the endpoint itself must stay
    // correct regardless -- genre affinity tracks *currently* right-swiped
    // items, and this is the one path that could otherwise leave it stale.
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['indie']))).run();
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(`INSERT INTO user_genres (id, user_id, genre, artist_count, track_count, created_at, updated_at) VALUES ('ug1', 'u1', 'indie', 1, 0, 1000, 1000)`).run();

    await worker.fetch(
      new Request('http://localhost/api/swipes/music/s1', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'skip' }),
      }),
      env,
      ctx
    );

    expect(await affinityFor('u1', 'indie')).toBe(0);
  });
});

describe('genre affinity tracking on POST /api/swipe/music', () => {
  async function affinityFor(userId: string, genre: string): Promise<number> {
    const row = await env.DB.prepare('SELECT (artist_count + track_count) as total FROM user_genres WHERE user_id = ? AND genre = ?')
      .bind(userId, genre)
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  async function artistTrackCountsFor(userId: string, genre: string): Promise<{ artistCount: number; trackCount: number }> {
    const row = await env.DB.prepare('SELECT artist_count, track_count FROM user_genres WHERE user_id = ? AND genre = ?')
      .bind(userId, genre)
      .first<{ artist_count: number; track_count: number }>();
    return { artistCount: row?.artist_count ?? 0, trackCount: row?.track_count ?? 0 };
  }

  const swipe = (cookie: string, itemType: string, itemId: string, direction: string) =>
    worker.fetch(
      new Request('http://localhost/api/swipe/music', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: itemType, item_id: itemId, direction }),
      }),
      env,
      ctx
    );

  it('increments the swiped artist\'s genres on a right-swipe', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['indie', 'rock']))).run();
    const cookie = await cookieFor('u1');

    await swipe(cookie, 'artist', 'a1', 'right');

    expect(await affinityFor('u1', 'indie')).toBe(1);
    expect(await affinityFor('u1', 'rock')).toBe(1);
    // Confirms the split, not just the combined total: an artist right-swipe
    // must land in artist_count, not track_count.
    expect(await artistTrackCountsFor('u1', 'indie')).toEqual({ artistCount: 1, trackCount: 0 });
  });

  it('increments via the artist\'s genres when swiping right on a track, and also counts the auto-liked artist', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['jazz']))).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, source, approved, created_at) VALUES ('t1', 'Track One', 'a1', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    await swipe(cookie, 'track', 't1', 'right');

    expect(await affinityFor('u1', 'jazz')).toBe(2);
    // Liking a track now also likes its artist (see 'auto-likes the artist'
    // tests below), so both counts land for the same genre.
    expect(await artistTrackCountsFor('u1', 'jazz')).toEqual({ artistCount: 1, trackCount: 1 });
  });

  it('does not double-increment when the same item is right-swiped again', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['pop']))).run();
    const cookie = await cookieFor('u1');

    await swipe(cookie, 'artist', 'a1', 'right');
    await swipe(cookie, 'artist', 'a1', 'right');

    expect(await affinityFor('u1', 'pop')).toBe(1);
  });

  it('decrements when a right-swipe is changed to left, and floors at 0', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['metal']))).run();
    const cookie = await cookieFor('u1');

    await swipe(cookie, 'artist', 'a1', 'right');
    expect(await affinityFor('u1', 'metal')).toBe(1);

    await swipe(cookie, 'artist', 'a1', 'left');
    expect(await affinityFor('u1', 'metal')).toBe(0);
  });

  it('does nothing to genre affinity for a left-swipe on an item never right-swiped', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['folk']))).run();
    const cookie = await cookieFor('u1');

    await swipe(cookie, 'artist', 'a1', 'left');

    expect(await affinityFor('u1', 'folk')).toBe(0);
  });
});

describe('genre pass tracking on POST /api/swipe/music', () => {
  async function passCountFor(userId: string, genre: string): Promise<number> {
    const row = await env.DB.prepare('SELECT pass_count FROM user_genres WHERE user_id = ? AND genre = ?')
      .bind(userId, genre)
      .first<{ pass_count: number }>();
    return row?.pass_count ?? 0;
  }

  const swipe = (cookie: string, itemType: string, itemId: string, direction: string) =>
    worker.fetch(
      new Request('http://localhost/api/swipe/music', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: itemType, item_id: itemId, direction }),
      }),
      env,
      ctx
    );

  it('increments pass_count on a fresh left-swipe', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['country']))).run();
    const cookie = await cookieFor('u1');

    await swipe(cookie, 'artist', 'a1', 'left');

    expect(await passCountFor('u1', 'country')).toBe(1);
  });

  it('does not double-increment when the same item is left-swiped again', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['country']))).run();
    const cookie = await cookieFor('u1');

    await swipe(cookie, 'artist', 'a1', 'left');
    await swipe(cookie, 'artist', 'a1', 'left');

    expect(await passCountFor('u1', 'country')).toBe(1);
  });

  it('decrements pass_count, floored at 0, when a left-swipe is changed to right', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['country']))).run();
    const cookie = await cookieFor('u1');

    await swipe(cookie, 'artist', 'a1', 'left');
    expect(await passCountFor('u1', 'country')).toBe(1);

    await swipe(cookie, 'artist', 'a1', 'right');
    expect(await passCountFor('u1', 'country')).toBe(0);
  });

  it('also counts as a pass when undoing a like (right-swipe changed to left)', async () => {
    // A right->left change is both "no longer liked" (artist_count/
    // track_count decrement, tested above) and "now passed" (pass_count
    // increment) -- the current state is left, regardless of how it got
    // there.
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['country']))).run();
    const cookie = await cookieFor('u1');

    await swipe(cookie, 'artist', 'a1', 'right');
    await swipe(cookie, 'artist', 'a1', 'left');

    expect(await passCountFor('u1', 'country')).toBe(1);
  });

  it('returns crossedGenre exactly when pass_count reaches the threshold, not before or after', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['country']))).run();
    const cookie = await cookieFor('u1');

    // 9 prior passes on 9 different artists sharing the 'country' genre --
    // none of these should trigger the prompt yet.
    for (let i = 0; i < 9; i++) {
      await env.DB.prepare(
        `INSERT INTO artists (id, name, genres, image_url, source, approved, created_at) VALUES (?, ?, ?, 'https://img.example/x.jpg', 'seed', 1, 1000)`
      )
        .bind(`prior${i}`, `Prior ${i}`, JSON.stringify(genresToObject(['country'])))
        .run();
      const res = await swipe(cookie, 'artist', `prior${i}`, 'left');
      expect((await res.json<any>()).crossedGenre).toBeNull();
    }
    expect(await passCountFor('u1', 'country')).toBe(9);

    const tenthRes = await swipe(cookie, 'artist', 'a1', 'left');
    expect((await tenthRes.json<any>()).crossedGenre).toBe('country');

    await env.DB.prepare(
      `INSERT INTO artists (id, name, genres, image_url, source, approved, created_at) VALUES ('a3', 'Artist Three', ?, 'https://img.example/a3.jpg', 'seed', 1, 1000)`
    )
      .bind(JSON.stringify(genresToObject(['country'])))
      .run();
    const eleventhRes = await swipe(cookie, 'artist', 'a3', 'left');
    expect((await eleventhRes.json<any>()).crossedGenre).toBeNull(); // already prompted once
  });
});

describe('liking a track auto-likes its artist', () => {
  const swipe = (cookie: string, itemType: string, itemId: string, direction: string) =>
    worker.fetch(
      new Request('http://localhost/api/swipe/music', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: itemType, item_id: itemId, direction }),
      }),
      env,
      ctx
    );

  async function artistDirection(userId: string, artistId: string): Promise<string | null> {
    const row = await env.DB.prepare(`SELECT direction FROM music_swipes WHERE user_id = ? AND item_type = 'artist' AND item_id = ?`)
      .bind(userId, artistId)
      .first<{ direction: string }>();
    return row?.direction ?? null;
  }

  it('right-swiping a track creates a right-swipe on its artist too', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, source, approved, created_at) VALUES ('t1', 'Track One', 'a1', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    await swipe(cookie, 'track', 't1', 'right');

    expect(await artistDirection('u1', 'a1')).toBe('right');
  });

  it('does not touch the artist swipe again once already liked (no duplicate row, no double genre count)', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['pop']))).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, source, approved, created_at) VALUES ('t1', 'Track One', 'a1', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, source, approved, created_at) VALUES ('t2', 'Track Two', 'a1', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    await swipe(cookie, 'track', 't1', 'right');
    await swipe(cookie, 'track', 't2', 'right');

    const rows = await env.DB.prepare(`SELECT * FROM music_swipes WHERE user_id = ? AND item_type = 'artist' AND item_id = ?`).bind('u1', 'a1').all();
    expect(rows.results.length).toBe(1); // still one row, not two
    const row = await env.DB.prepare('SELECT (artist_count + track_count) as total FROM user_genres WHERE user_id = ? AND genre = ?').bind('u1', 'pop').first<any>();
    expect(row.total).toBe(3); // artist +1 (from the first track's auto-like) + track +1 + track +1, not +2 for the artist
  });

  it('upgrades a previously passed-on artist to liked when a track of theirs is liked', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, source, approved, created_at) VALUES ('t1', 'Track One', 'a1', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    await swipe(cookie, 'artist', 'a1', 'left');
    expect(await artistDirection('u1', 'a1')).toBe('left');

    await swipe(cookie, 'track', 't1', 'right');

    expect(await artistDirection('u1', 'a1')).toBe('right');
  });

  it('does not auto-unlike the artist when the track is later passed on', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, source, approved, created_at) VALUES ('t1', 'Track One', 'a1', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    await swipe(cookie, 'track', 't1', 'right');
    expect(await artistDirection('u1', 'a1')).toBe('right');

    await swipe(cookie, 'track', 't1', 'left');

    expect(await artistDirection('u1', 'a1')).toBe('right'); // unchanged
  });

  it('does not affect anything when swiping right on an artist directly', async () => {
    const cookie = await cookieFor('u1');

    await swipe(cookie, 'artist', 'a1', 'right');

    const rows = await env.DB.prepare(`SELECT * FROM music_swipes WHERE user_id = ?`).bind('u1').all();
    expect(rows.results.length).toBe(1); // just the one artist swipe, nothing extra
  });

  it('also auto-likes the artist via PATCH /api/swipes/music/:id (the History "Change" toggle)', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, source, approved, created_at) VALUES ('t1', 'Track One', 'a1', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    await swipe(cookie, 'track', 't1', 'left');
    const trackSwipe = await env.DB.prepare(`SELECT id FROM music_swipes WHERE user_id = ? AND item_id = 't1'`).bind('u1').first<{ id: string }>();

    await worker.fetch(
      new Request(`http://localhost/api/swipes/music/${trackSwipe!.id}`, {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'right' }),
      }),
      env,
      ctx
    );

    expect(await artistDirection('u1', 'a1')).toBe('right');
  });
});

describe('GET /api/swipes/music and PATCH', () => {
  it('lists history and allows changing a past decision', async () => {
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'left', 1000, 1000)`
    ).run();

    const historyRes = await worker.fetch(new Request('http://localhost/api/swipes/music', { headers: { Cookie: cookie } }), env, ctx);
    const history = await historyRes.json<any>();
    expect(history.swipes[0].direction).toBe('left');
    expect(history.swipes[0].name).toBe('Artist One');

    const patchRes = await worker.fetch(
      new Request('http://localhost/api/swipes/music/s1', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'right' }),
      }),
      env,
      ctx
    );
    expect(patchRes.status).toBe(200);
    const row = await env.DB.prepare('SELECT direction FROM music_swipes WHERE id = ?').bind('s1').first<any>();
    expect(row.direction).toBe('right');
  });

  it('rejects an invalid direction via PATCH, writing nothing', async () => {
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'left', 1000, 1000)`
    ).run();

    const res = await worker.fetch(
      new Request('http://localhost/api/swipes/music/s1', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'up' }),
      }),
      env,
      ctx
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_direction');
    const row = await env.DB.prepare('SELECT direction FROM music_swipes WHERE id = ?').bind('s1').first<any>();
    expect(row.direction).toBe('left');
  });

  it('tracks genre passes and reports crossedGenre via PATCH too, the same as a fresh POST swipe', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = '{"country":true}' WHERE id = 'a1'`).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'right', 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    const patchRes = await worker.fetch(
      new Request('http://localhost/api/swipes/music/s1', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'left' }),
      }),
      env,
      ctx
    );

    expect((await patchRes.json<any>()).crossedGenre).toBeNull(); // only the 1st pass, not the 10th
    const row = await env.DB.prepare('SELECT pass_count FROM user_genres WHERE user_id = ? AND genre = ?').bind('u1', 'country').first<any>();
    expect(row.pass_count).toBe(1);
  });

  it('resolves artist_id for both artist and track history rows, for linking to the artist page', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, source, approved, created_at) VALUES ('t1', 'Track One', 'a2', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s2', 'u1', 'track', 't1', 'right', 1000, 1000)`
    ).run();

    const res = await worker.fetch(new Request('http://localhost/api/swipes/music', { headers: { Cookie: cookie } }), env, ctx);
    const body = await res.json<any>();
    expect(body.swipes.find((s: any) => s.id === 's1').artist_id).toBe('a1');
    expect(body.swipes.find((s: any) => s.id === 's2').artist_id).toBe('a2');
  });

  it('filters by item_type -- History splits Artists and Tracks into separate tabs', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, source, approved, created_at) VALUES ('t1', 'Track One', 'a2', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s2', 'u1', 'track', 't1', 'right', 1000, 1000)`
    ).run();

    const artistsRes = await worker.fetch(new Request('http://localhost/api/swipes/music?item_type=artist', { headers: { Cookie: cookie } }), env, ctx);
    const artistsBody = await artistsRes.json<any>();
    expect(artistsBody.swipes.map((s: any) => s.id)).toEqual(['s1']);

    const tracksRes = await worker.fetch(new Request('http://localhost/api/swipes/music?item_type=track', { headers: { Cookie: cookie } }), env, ctx);
    const tracksBody = await tracksRes.json<any>();
    expect(tracksBody.swipes.map((s: any) => s.id)).toEqual(['s2']);

    // No item_type -- both together, unchanged pre-split behavior.
    const bothRes = await worker.fetch(new Request('http://localhost/api/swipes/music', { headers: { Cookie: cookie } }), env, ctx);
    const bothBody = await bothRes.json<any>();
    expect(bothBody.swipes).toHaveLength(2);
  });

  it('combines item_type and direction filters', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, source, approved, created_at) VALUES ('t1', 'Track One', 'a2', 'seed', 1, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s2', 'u1', 'artist', 'a2', 'left', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s3', 'u1', 'track', 't1', 'right', 1000, 1000)`
    ).run();

    const res = await worker.fetch(
      new Request('http://localhost/api/swipes/music?item_type=artist&direction=right', { headers: { Cookie: cookie } }),
      env,
      ctx
    );
    const body = await res.json<any>();
    expect(body.swipes.map((s: any) => s.id)).toEqual(['s1']);
  });

  it('updates genre affinity when changing a past decision to right', async () => {
    // Same bug class as the people-swipe match-on-toggle regression: genre
    // affinity was only ever applied from the fresh-swipe POST handler, so
    // completing a like via the History "Change" toggle silently skipped it.
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['indie']))).run();
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'left', 1000, 1000)`
    ).run();

    await worker.fetch(
      new Request('http://localhost/api/swipes/music/s1', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'right' }),
      }),
      env,
      ctx
    );

    const affinity = await env.DB.prepare('SELECT artist_count FROM user_genres WHERE user_id = ? AND genre = ?').bind('u1', 'indie').first<any>();
    expect(affinity.artist_count).toBe(1);
  });

  it('does not double-count genre affinity when re-confirming an already-right swipe via PATCH', async () => {
    await env.DB.prepare(`UPDATE artists SET genres = ? WHERE id = 'a1'`).bind(JSON.stringify(genresToObject(['pop']))).run();
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(`INSERT INTO user_genres (id, user_id, genre, artist_count, track_count, created_at, updated_at) VALUES ('ug4', 'u1', 'pop', 1, 0, 1000, 1000)`).run();

    await worker.fetch(
      new Request('http://localhost/api/swipes/music/s1', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'right' }),
      }),
      env,
      ctx
    );

    const affinity = await env.DB.prepare('SELECT artist_count FROM user_genres WHERE user_id = ? AND genre = ?').bind('u1', 'pop').first<any>();
    expect(affinity.artist_count).toBe(1);
  });

  it('filters history by direction when ?direction= is given', async () => {
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'left', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s2', 'u1', 'artist', 'a2', 'right', 2000, 2000)`
    ).run();

    const rightRes = await worker.fetch(
      new Request('http://localhost/api/swipes/music?direction=right', { headers: { Cookie: cookie } }),
      env,
      ctx
    );
    const rightBody = await rightRes.json<any>();
    expect(rightBody.swipes.map((s: any) => s.id)).toEqual(['s2']);

    const leftRes = await worker.fetch(
      new Request('http://localhost/api/swipes/music?direction=left', { headers: { Cookie: cookie } }),
      env,
      ctx
    );
    const leftBody = await leftRes.json<any>();
    expect(leftBody.swipes.map((s: any) => s.id)).toEqual(['s1']);
  });

  it('rejects patching a swipe owned by another user', async () => {
    await insertTestUser(env.DB, {
      id: 'u2',
      spotifyId: 'sp2',
      accessToken: 'a',
      refreshToken: 'r',
      tokenExpiresAt: 9999999999999,
      createdAt: 1000,
      updatedAt: 1000,
    });
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'left', 1000, 1000)`
    ).run();
    const before = await env.DB.prepare('SELECT direction, updated_at FROM music_swipes WHERE id = ?').bind('s1').first<any>();

    const u2cookie = await cookieFor('u2');
    const patchRes = await worker.fetch(
      new Request('http://localhost/api/swipes/music/s1', {
        method: 'PATCH',
        headers: { Cookie: u2cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'right' }),
      }),
      env,
      ctx
    );
    expect(patchRes.status).toBe(404);

    const after = await env.DB.prepare('SELECT direction, updated_at FROM music_swipes WHERE id = ?').bind('s1').first<any>();
    expect(after.direction).toBe(before.direction);
    expect(after.updated_at).toBe(before.updated_at);
  });
});

describe('GET /api/swipes/music -- total (issue #2)', () => {
  it('counts everything matching, not just the page returned', async () => {
    for (let i = 0; i < 25; i++) {
      await env.DB.prepare(
        `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at)
         VALUES (?, 'u1', 'artist', ?, 'right', ?, ?)`
      )
        .bind(`s${i}`, `a${i}`, 1000 + i, 1000 + i)
        .run();
    }

    const res = await worker.fetch(
      new Request('http://localhost/api/swipes/music?limit=10&item_type=artist', { headers: { Cookie: await cookieFor('u1') } }),
      env,
      {} as ExecutionContext
    );
    const body = await res.json<any>();

    expect(body.swipes).toHaveLength(10);
    expect(body.total).toBe(25);
  });

  it('respects the direction and item_type filters', async () => {
    const rows: Array<[string, string, string]> = [
      ['s1', 'artist', 'right'],
      ['s2', 'artist', 'left'],
      ['s3', 'track', 'right'],
    ];
    for (const [id, type, dir] of rows) {
      await env.DB.prepare(
        `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at)
         VALUES (?, 'u1', ?, ?, ?, 1000, 1000)`
      )
        .bind(id, type, `item-${id}`, dir)
        .run();
    }
    const cookie = await cookieFor('u1');

    const liked = await (await worker.fetch(
      new Request('http://localhost/api/swipes/music?item_type=artist&direction=right', { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    )).json<any>();
    // "247 songs" while filtered to likes has to mean 247 LIKED songs.
    expect(liked.total).toBe(1);

    const allArtists = await (await worker.fetch(
      new Request('http://localhost/api/swipes/music?item_type=artist', { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    )).json<any>();
    expect(allArtists.total).toBe(2);
  });

  it('is zero for a user with no swipes', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/swipes/music', { headers: { Cookie: await cookieFor('u1') } }),
      env,
      {} as ExecutionContext
    );
    expect((await res.json<any>()).total).toBe(0);
  });
});
