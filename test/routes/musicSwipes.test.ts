import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import { genresToObject } from '../../src/lib/genres';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM user_genres; DELETE FROM music_swipes; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM sessions; DELETE FROM tracks; DELETE FROM users; DELETE FROM artists;'
  );
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
    await env.DB.prepare(`INSERT INTO user_genres (user_id, genre, artist_count, track_count, updated_at) VALUES ('u1', 'pop', 1, 0, 1000)`).run();

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
