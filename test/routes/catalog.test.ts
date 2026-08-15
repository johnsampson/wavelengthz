import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import { processArtistTrackBackfillBatch, type ArtistTrackBackfillMessage } from '../../src/lib/artistTrackBackfill';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  // Children before parents: tracks/artists reference users via added_by_user_id,
  // and tracks references artists — deleting users/artists first trips the FK constraint
  // once a prior test has left a row with a non-null reference.
  await env.DB.exec(
    'DELETE FROM genres; DELETE FROM music_swipes; DELETE FROM sessions; DELETE FROM tracks; DELETE FROM artists; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
  // fetchArtistTracksCached (src/routes/catalog.ts) caches GET /api/artists/:id's
  // track fetch in RATE_LIMIT_KV, keyed by spotify_id+limit -- since most tests
  // below reuse the same seeded 'local-1' artist, a stale cached result from an
  // earlier test would otherwise leak into a later one asserting a different
  // track list for that same artist/limit pair.
  const cachedKeys = await env.RATE_LIMIT_KV.list({ prefix: 'artist-tracks-cache:' });
  await Promise.all(cachedKeys.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
  // enqueueArtistTrackBackfill (src/lib/artistTrackBackfill.ts) sets a
  // pending-lock key per spotify_id -- since most tests below reuse the
  // same seeded 'local-1'/'spotify-local-1' artist, a lock an earlier test
  // left behind would silently no-op a later test's own enqueue attempt.
  const pendingBackfillKeys = await env.RATE_LIMIT_KV.list({ prefix: 'artist-backfill-pending:' });
  await Promise.all(pendingBackfillKeys.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
  await env.RATE_LIMIT_KV.delete('spotify-cooldown');
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', createdAt: 1000, updatedAt: 1000 });
  await env.DB.prepare(
    `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at) VALUES ('local-1', 'spotify-local-1', 'Local Artist', '{"pop":true}', 'seed', 1, 1000)`
  ).run();
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

function stubSpotify() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      if (url.includes('/v1/search') && url.includes('type=artist')) {
        return new Response(
          JSON.stringify({ artists: { items: [{ id: 'new-artist', name: 'New Artist', genres: ['indie'], images: [], popularity: 50 }] } }),
          { status: 200 }
        );
      }
      if (url.includes('/v1/artists/new-artist')) {
        return new Response(JSON.stringify({ id: 'new-artist', name: 'New Artist', genres: ['indie'], images: [], popularity: 50 }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    })
  );
}

describe('GET /api/artists/search', () => {
  it('returns local matches merged with live Spotify results, tagged by catalog membership', async () => {
    stubSpotify();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/artists/search?q=art', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    const local = body.results.find((r: any) => r.id === 'local-1');
    // Not yet in our catalog -- no internal id exists, so it's surfaced
    // under spotifyArtistId instead of id (see GET /api/artists/search).
    const fresh = body.results.find((r: any) => r.spotifyArtistId === 'new-artist');
    expect(local.inCatalog).toBe(true);
    expect(local.genres).toEqual(['pop']); // stored as {pop: true} on the row, exposed as an array
    expect(fresh.inCatalog).toBe(false);
    vi.unstubAllGlobals();
  });

  it('dedupes an artist that appears in both the local catalog and the live Spotify results', async () => {
    // Stub Spotify's artist search to return the SAME spotify_id already
    // seeded locally ('spotify-local-1'), simulating the case where a
    // catalog artist also matches the live search. Dedup compares against
    // spotify_id, not the internal id.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('/v1/search') && url.includes('type=artist')) {
          return new Response(
            JSON.stringify({
              artists: { items: [{ id: 'spotify-local-1', name: 'Local Artist', genres: ['pop'], images: [], popularity: 40 }] },
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected ${url}`);
      })
    );
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/artists/search?q=local', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    const matches = body.results.filter((r: any) => r.id === 'local-1');
    expect(matches).toHaveLength(1);
    expect(matches[0].inCatalog).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('GET /api/artists/:id', () => {
  // The dedicated "top tracks" endpoint is 403'd for this app (see
  // fetchArtistTracks's comment block in spotify.ts), so the artist-profile
  // route goes via GET /v1/artists/{id}/albums -> GET /v1/albums/{id}/tracks.
  // No separate per-track detail fetch: the album-tracks response already
  // carries name/preview_url/artists, and album art comes from the album's
  // own `images` (captured once, from the albums-list call above) rather
  // than a track object. Simplified here to a single fake album containing
  // every requested track, all sharing that one album's art.
  function stubTrackSearch(trackSearchResponse: any, extra?: (url: string) => Response | null) {
    const tracks = trackSearchResponse.tracks;
    const albumImages = tracks[0]?.album?.images ?? [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: tracks.length > 0 ? [{ id: 'album-1', images: albumImages }] : [] }), { status: 200 });
        }
        if (url.includes('/albums/album-1/tracks')) {
          return new Response(
            JSON.stringify({ items: tracks.map((t: any) => ({ id: t.id, name: t.name, preview_url: t.preview_url ?? null, artists: t.artists })) }),
            { status: 200 }
          );
        }
        if (extra) {
          const res = extra(url);
          if (res) return res;
        }
        throw new Error(`unexpected ${url}`);
      })
    );
  }

  it('returns an already-catalogued artist with its top tracks upserted and no swipe direction yet', async () => {
    stubTrackSearch({
      tracks: [
        { id: 'trk1', name: 'Track One', artists: [{ id: 'spotify-local-1', name: 'Local Artist' }], album: { images: [{ url: 'https://img.example/trk1.jpg' }] }, preview_url: 'https://prev/trk1' },
        { id: 'trk2', name: 'Track Two', artists: [{ id: 'spotify-local-1', name: 'Local Artist' }], album: { images: [] }, preview_url: null },
      ],
    });
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();

    expect(body.artist.id).toBe('local-1');
    expect(body.artist.genres).toEqual(['pop']);
    // t.id is the internal UUID now (freshly generated on upsert) -- t.spotifyId
    // is the one that still identifies which Spotify track this is.
    expect(body.tracks.map((t: any) => t.spotifyId)).toEqual(['trk1', 'trk2']);
    expect(body.tracks[0].imageUrl).toBe('https://img.example/trk1.jpg');
    expect(body.tracks[0].direction).toBeNull();

    const row = await env.DB.prepare('SELECT * FROM tracks WHERE spotify_id = ?').bind('trk1').first<any>();
    expect(row).not.toBeNull();
    expect(row.artist_id).toBe('local-1');
    expect(row.id).toBe(body.tracks[0].id);

    vi.unstubAllGlobals();
  });

  it('fetches and upserts an artist not yet in the catalog', async () => {
    stubTrackSearch({ tracks: [] }, (url) => {
      if (url.includes('/v1/artists/new-artist')) {
        return new Response(JSON.stringify({ id: 'new-artist', name: 'New Artist', genres: ['indie'], images: [{ url: 'https://img.example/new.jpg' }], popularity: 40 }), { status: 200 });
      }
      return null;
    });
    const cookie = await cookieFor('u1');
    // :id is resolved as a raw Spotify id here since it's not yet cataloged
    // under any internal id or spotify_id -- see GET /api/artists/:id.
    const req = new Request('http://localhost/api/artists/new-artist', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.artist.name).toBe('New Artist');
    expect(body.artist.genres).toEqual(['indie']);
    expect(body.artist.id).not.toBe('new-artist'); // internal id, not the Spotify one

    const row = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('new-artist').first<any>();
    expect(row.source).toBe('spotify_search');
    expect(row.id).toBe(body.artist.id);

    const genreRow = await env.DB.prepare('SELECT * FROM genres WHERE genre = ?').bind('indie').first<any>();
    expect(genreRow.artist_count).toBe(1);

    vi.unstubAllGlobals();
  });

  it('reports the current direction for a track the user already swiped on', async () => {
    stubTrackSearch({
      tracks: [{ id: 'trk1', name: 'Track One', artists: [{ id: 'spotify-local-1', name: 'Local Artist' }], album: { images: [] }, preview_url: null }],
    });
    // Pre-seed the track under a known internal id so the swipe fixture
    // below can reference it -- upsertTrack finds it via spotify_id and
    // reuses this same id rather than generating a new one.
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, source, approved, created_at) VALUES ('track1-internal', 'trk1', 'Track One', 'local-1', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'track', 'track1-internal', 'right', 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.tracks[0].direction).toBe('right');
    vi.unstubAllGlobals();
  });

  describe('pagination via ?limit=', () => {
    function makeTracks(count: number) {
      return Array.from({ length: count }, (_, i) => ({
        id: `trk${i}`,
        name: `Track ${i}`,
        artists: [{ id: 'spotify-local-1', name: 'Local Artist' }],
        album: { images: [] },
        preview_url: null,
      }));
    }

    // No ?limit= is the quick path now (see the "quick path" describe block
    // below for the full behavior) -- these two just confirm the plain
    // pagination contract (?limit= itself, hasMore near the ceiling) is
    // unaffected, since that's still served by the original, unchanged
    // fetchArtistTracksCached path.

    it('honors a higher ?limit=, returning more tracks than the server default', async () => {
      stubTrackSearch({ tracks: makeTracks(10) });
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1?limit=5', { headers: { Cookie: cookie } });
      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();
      expect(body.tracks.map((t: any) => t.spotifyId)).toEqual(['trk0', 'trk1', 'trk2', 'trk3', 'trk4']);
      vi.unstubAllGlobals();
    });

    it('reports hasMore: false once the artist runs out of tracks before hitting the requested limit', async () => {
      stubTrackSearch({ tracks: makeTracks(2) });
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1?limit=30', { headers: { Cookie: cookie } });
      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();
      expect(body.tracks).toHaveLength(2);
      expect(body.hasMore).toBe(false);
      vi.unstubAllGlobals();
    });

    it('clamps an oversized ?limit= to the ceiling and reports no further hasMore there', async () => {
      stubTrackSearch({ tracks: makeTracks(200) });
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1?limit=99999', { headers: { Cookie: cookie } });
      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();
      expect(body.tracks).toHaveLength(90); // ARTIST_PROFILE_TRACK_MAX_LIMIT
      expect(body.hasMore).toBe(false);
      vi.unstubAllGlobals();
    });

    it('treats a non-numeric or non-positive ?limit= the same as no ?limit= (the quick path), not an error', async () => {
      stubTrackSearch({ tracks: makeTracks(30) });
      const cookie = await cookieFor('u1');
      for (const limit of ['abc', '0', '-5']) {
        const req = new Request(`http://localhost/api/artists/local-1?limit=${limit}`, { headers: { Cookie: cookie } });
        const res = await worker.fetch(req, env, {} as ExecutionContext);
        expect(res.status).toBe(200);
        const body = await res.json<any>();
        expect(body.tracks.length).toBeLessThanOrEqual(5); // QUICK_TRACK_LIMIT, not the 30-track error case
      }
      vi.unstubAllGlobals();
    });
  });

  describe('totalLikes and totalLikesInArea', () => {
    beforeEach(async () => {
      // Austin-area viewer, 80km radius (matches the default fixture in other
      // test files).
      await env.DB.prepare('UPDATE users SET lat = 30.27, lng = -97.74, max_distance_km = 80 WHERE id = ?').bind('u1').run();
      await insertTestUser(env.DB, { id: 'near1', spotifyId: 'sp-near1', lat: 30.27, lng: -97.74, createdAt: 1000, updatedAt: 1000 });
      await insertTestUser(env.DB, { id: 'near2', spotifyId: 'sp-near2', lat: 30.27, lng: -97.74, createdAt: 1000, updatedAt: 1000 });
      // London -- far outside any reasonable radius from Austin.
      await insertTestUser(env.DB, { id: 'far1', spotifyId: 'sp-far1', lat: 51.5, lng: -0.12, createdAt: 1000, updatedAt: 1000 });
      await env.DB.prepare(
        `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('lk1', 'near1', 'artist', 'local-1', 'right', 1000, 1000)`
      ).run();
      await env.DB.prepare(
        `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('lk2', 'near2', 'artist', 'local-1', 'right', 1000, 1000)`
      ).run();
      await env.DB.prepare(
        `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('lk3', 'far1', 'artist', 'local-1', 'right', 1000, 1000)`
      ).run();
      // A pass (left-swipe) must not count as a like.
      await env.DB.prepare(
        `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('lk4', 'u1', 'artist', 'local-1', 'left', 1000, 1000)`
      ).run();
    });

    it('counts every right-swipe on the artist for totalLikes, regardless of distance', async () => {
      stubTrackSearch({ tracks: [] });
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });
      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();
      expect(body.artist.totalLikes).toBe(3);
      vi.unstubAllGlobals();
    });

    it('counts only likers within the viewer\'s radius for totalLikesInArea', async () => {
      stubTrackSearch({ tracks: [] });
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });
      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();
      expect(body.artist.totalLikesInArea).toBe(2); // near1 + near2, not far1
      vi.unstubAllGlobals();
    });

    it('reports 0 totalLikesInArea when the viewer has no location set', async () => {
      await env.DB.prepare('UPDATE users SET lat = NULL, lng = NULL WHERE id = ?').bind('u1').run();
      stubTrackSearch({ tracks: [] });
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });
      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();
      expect(body.artist.totalLikesInArea).toBe(0);
      expect(body.artist.totalLikes).toBe(3); // unaffected -- this one doesn't need the viewer's location
      vi.unstubAllGlobals();
    });
  });

  describe('artist tracks caching (fetchArtistTracksCached)', () => {
    // Regression: repeatedly reloading the same artist page -- exactly what
    // happens while someone is testing/debugging it -- used to re-run the
    // whole ~40-call Spotify fan-out from scratch every time, which was
    // itself enough redundant traffic to keep re-tripping Spotify's own rate
    // limit. A short KV cache absorbs that.
    function stubTrackSearchCounting(tracks: any[]) {
      let albumsCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo) => {
          const url = input.toString();
          if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
          if (url.includes('/artists/') && url.includes('/albums')) {
            albumsCalls += 1;
            return new Response(JSON.stringify({ items: tracks.length > 0 ? [{ id: 'album-1', images: [] }] : [] }), { status: 200 });
          }
          if (url.includes('/albums/album-1/tracks')) {
            return new Response(
              JSON.stringify({ items: tracks.map((t) => ({ id: t.id, name: t.name, preview_url: t.preview_url ?? null, artists: t.artists })) }),
              { status: 200 }
            );
          }
          throw new Error(`unexpected ${url}`);
        })
      );
      return () => albumsCalls;
    }

    it('serves the second request for the same artist from cache, without calling Spotify again', async () => {
      const getAlbumsCalls = stubTrackSearchCounting([
        { id: 'trk1', name: 'Track One', artists: [{ id: 'spotify-local-1', name: 'Local Artist' }], album: { images: [] }, preview_url: null },
      ]);
      const cookie = await cookieFor('u1');
      const req = () => new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });

      const first = await worker.fetch(req(), env, {} as ExecutionContext);
      const firstBody = await first.json<any>();
      const second = await worker.fetch(req(), env, {} as ExecutionContext);
      const secondBody = await second.json<any>();

      expect(getAlbumsCalls()).toBe(1); // not 2 -- the second request never touched Spotify
      expect(secondBody.tracks.map((t: any) => t.spotifyId)).toEqual(firstBody.tracks.map((t: any) => t.spotifyId));
      vi.unstubAllGlobals();
    });

    it('does not reuse a cached result across different ?limit= values for the same artist', async () => {
      const getAlbumsCalls = stubTrackSearchCounting(
        Array.from({ length: 10 }, (_, i) => ({
          id: `trk${i}`,
          name: `Track ${i}`,
          artists: [{ id: 'spotify-local-1', name: 'Local Artist' }],
          album: { images: [] },
          preview_url: null,
        }))
      );
      const cookie = await cookieFor('u1');

      // ?limit=10, not ?limit=5 -- 5 would coincidentally collide with
      // QUICK_TRACK_LIMIT's own cache key (the no-?limit= request just below
      // populates that one), which is a deliberate, separate optimization
      // (see the "quick path" describe block), not what this test is about.
      await worker.fetch(new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
      await worker.fetch(new Request('http://localhost/api/artists/local-1?limit=10', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);

      expect(getAlbumsCalls()).toBe(2); // different cache key per limit -- both are live fetches
      vi.unstubAllGlobals();
    });

    it('falls back to a live fetch when the KV cache read fails, instead of failing the request', async () => {
      const getAlbumsCalls = stubTrackSearchCounting([
        { id: 'trk1', name: 'Track One', artists: [{ id: 'spotify-local-1', name: 'Local Artist' }], album: { images: [] }, preview_url: null },
      ]);
      const brokenKv = {
        get: async () => {
          throw new Error('KV namespace unavailable');
        },
        put: async () => {},
        list: env.RATE_LIMIT_KV.list.bind(env.RATE_LIMIT_KV),
        delete: env.RATE_LIMIT_KV.delete.bind(env.RATE_LIMIT_KV),
      };
      const brokenEnv = { ...env, RATE_LIMIT_KV: brokenKv } as any;
      const cookie = await cookieFor('u1');

      const res = await worker.fetch(
        new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } }),
        brokenEnv,
        {} as ExecutionContext
      );

      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.tracks).toHaveLength(1);
      expect(getAlbumsCalls()).toBe(1);
      vi.unstubAllGlobals();
    });
  });

  describe('DB-first resolution -- tracks already in D1 are served without touching Spotify at all', () => {
    // Directly seeds `tracks` rows for local-1, bypassing Spotify entirely --
    // simulates an artist whose catalog was already populated by a prior
    // view or backfill (src/lib/artistTrackBackfill.ts).
    async function insertTracks(count: number) {
      for (let i = 0; i < count; i++) {
        await env.DB.prepare(
          `INSERT INTO tracks (id, spotify_id, name, artist_id, album_image_url, preview_url, source, approved, created_at, updated_at)
           VALUES (?, ?, ?, 'local-1', ?, NULL, 'seed', 1, 1000, 1000)`
        )
          .bind(`internal-trk${i}`, `trk${i}`, `Track ${i}`, i === 0 ? 'https://img.example/trk0.jpg' : null)
          .run();
      }
    }

    function throwingFetch() {
      // No branch returns successfully -- any Spotify call at all fails the
      // test outright rather than silently returning a plausible-looking
      // empty response that could mask a regression.
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
        throw new Error(`Spotify should not have been called: ${input.toString()}`);
      }));
    }

    it('serves the default view entirely from D1, with zero Spotify calls, once the artist already has at least the default limit stored', async () => {
      await insertTracks(30); // ARTIST_PROFILE_TRACK_LIMIT
      throwingFetch();
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });

      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();

      expect(res.status).toBe(200);
      expect(body.tracks).toHaveLength(30);
      expect(body.tracks.map((t: any) => t.spotifyId)).toEqual(Array.from({ length: 30 }, (_, i) => `trk${i}`));
      expect(body.tracks[0].imageUrl).toBe('https://img.example/trk0.jpg');
      expect(body.hasMore).toBe(true);
      vi.unstubAllGlobals();
    });

    it('serves an explicit ?limit= entirely from D1, with zero Spotify calls, once D1 already covers it', async () => {
      await insertTracks(40);
      throwingFetch();
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1?limit=30', { headers: { Cookie: cookie } });

      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();

      expect(res.status).toBe(200);
      expect(body.tracks).toHaveLength(30); // capped to the requested limit, not all 40
      vi.unstubAllGlobals();
    });

    it('serves the default view\'s partial local coverage immediately without calling Spotify, and enqueues a backfill for the rest', async () => {
      await insertTracks(5); // fewer than ARTIST_PROFILE_TRACK_LIMIT
      throwingFetch();
      const sendSpy = vi.spyOn(env.ARTIST_TRACK_BACKFILL_QUEUE, 'send');
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });

      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();

      expect(res.status).toBe(200);
      expect(body.tracks).toHaveLength(5);
      expect(body.hasMore).toBe(true);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      sendSpy.mockRestore();
      vi.unstubAllGlobals();
    });

    it('still fetches live from Spotify to satisfy an explicit ?limit= that D1 does not yet cover, growing D1 for next time', async () => {
      await insertTracks(5);
      const makeTracks = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
          id: `sp-trk${i}`,
          name: `Spotify Track ${i}`,
          preview_url: null,
          artists: [{ id: 'spotify-local-1', name: 'Local Artist' }],
        }));
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo) => {
          const url = input.toString();
          if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
          if (url.includes('/artists/') && url.includes('/albums')) {
            return new Response(JSON.stringify({ items: [{ id: 'album-1', images: [] }] }), { status: 200 });
          }
          if (url.includes('/albums/album-1/tracks')) {
            return new Response(JSON.stringify({ items: makeTracks(30) }), { status: 200 });
          }
          throw new Error(`unexpected ${url}`);
        })
      );
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1?limit=30', { headers: { Cookie: cookie } });

      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();

      expect(res.status).toBe(200);
      expect(body.tracks).toHaveLength(30);
      const rows = await env.DB.prepare('SELECT COUNT(*) as c FROM tracks WHERE artist_id = ?').bind('local-1').first<{ c: number }>();
      expect(rows!.c).toBe(35); // the original 5 plus 30 newly-upserted (all distinct spotify_ids)
      vi.unstubAllGlobals();
    });
  });

  describe('quick path on a first (no ?limit=) view of an uncached artist', () => {
    function makeTracks(count: number) {
      return Array.from({ length: count }, (_, i) => ({
        id: `trk${i}`,
        name: `Track ${i}`,
        artists: [{ id: 'spotify-local-1', name: 'Local Artist' }],
        album: { images: [] },
        preview_url: null,
      }));
    }

    // Same shape as stubTrackSearch above, plus a call counter -- needed
    // here (not just stubTrackSearch) to prove the second, post-backfill
    // view really is served from cache and not a second live fetch.
    function stubTrackSearchCounting(tracks: any[]) {
      let albumsCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo) => {
          const url = input.toString();
          if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
          if (url.includes('/artists/') && url.includes('/albums')) {
            albumsCalls += 1;
            return new Response(JSON.stringify({ items: tracks.length > 0 ? [{ id: 'album-1', images: [] }] : [] }), { status: 200 });
          }
          if (url.includes('/albums/album-1/tracks')) {
            return new Response(
              JSON.stringify({ items: tracks.map((t) => ({ id: t.id, name: t.name, preview_url: t.preview_url ?? null, artists: t.artists })) }),
              { status: 200 }
            );
          }
          throw new Error(`unexpected ${url}`);
        })
      );
      return () => albumsCalls;
    }

    function fakeBackfillBatch(messages: ArtistTrackBackfillMessage[]) {
      const acked: ArtistTrackBackfillMessage[] = [];
      const retried: ArtistTrackBackfillMessage[] = [];
      const batchMessages = messages.map((body, i) => ({
        id: `bm${i}`,
        timestamp: new Date(),
        body,
        attempts: 1,
        ack: () => acked.push(body),
        retry: () => retried.push(body),
      }));
      return {
        batch: { messages: batchMessages, queue: 'artist-track-backfill', metadata: {} as any, retryAll: () => {}, ackAll: () => {} },
        acked,
        retried,
      };
    }

    it('returns a small track set immediately and reports hasMore: true, even though far fewer than the server default came back', async () => {
      stubTrackSearch({ tracks: makeTracks(30) });
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });

      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();

      expect(res.status).toBe(200);
      expect(body.tracks.length).toBeLessThanOrEqual(5); // QUICK_TRACK_LIMIT
      expect(body.tracks.length).toBeGreaterThan(0);
      expect(body.hasMore).toBe(true);
      vi.unstubAllGlobals();
    });

    it('reports hasMore: false for a genuinely empty artist (no albums at all), not a false-positive "Load more"', async () => {
      stubTrackSearch({ tracks: [] });
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });

      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();

      expect(body.tracks).toHaveLength(0);
      expect(body.hasMore).toBe(false);
      vi.unstubAllGlobals();
    });

    it('once the backfill queue consumer completes, a later no-?limit= view serves the full set instantly from cache, with no further live Spotify calls', async () => {
      const getAlbumsCalls = stubTrackSearchCounting(makeTracks(30));
      const cookie = await cookieFor('u1');

      // First view: quick path, enqueues (but doesn't itself run) the backfill.
      const firstRes = await worker.fetch(
        new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } }),
        env,
        {} as ExecutionContext
      );
      const firstBody = await firstRes.json<any>();
      expect(firstBody.tracks.length).toBeLessThanOrEqual(5);
      const callsAfterQuickFetch = getAlbumsCalls();

      // Simulate the queue actually delivering that message -- this is the
      // same backfill job GET /api/artists/:id enqueued above, run directly
      // rather than waiting on real queue infrastructure in a test.
      const { batch, acked } = fakeBackfillBatch([{ artistId: 'local-1', spotifyArtistId: 'spotify-local-1', limit: 30 }]);
      await processArtistTrackBackfillBatch(batch as any, env as any);
      expect(acked).toHaveLength(1);

      // Second view: full result now cached by the backfill, no live Spotify
      // call needed at all.
      const secondRes = await worker.fetch(
        new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } }),
        env,
        {} as ExecutionContext
      );
      const secondBody = await secondRes.json<any>();

      expect(secondBody.tracks).toHaveLength(30);
      expect(secondBody.hasMore).toBe(true); // exactly ARTIST_PROFILE_TRACK_LIMIT came back
      expect(getAlbumsCalls()).toBe(callsAfterQuickFetch + 1); // +1 for the backfill's own live fetch, nothing for the second view
      vi.unstubAllGlobals();
    });

    it('the backfill consumer upserts every track it fetches, not just the quick handful', async () => {
      stubTrackSearchCounting(makeTracks(10));
      const { batch } = fakeBackfillBatch([{ artistId: 'local-1', spotifyArtistId: 'spotify-local-1', limit: 30 }]);

      await processArtistTrackBackfillBatch(batch as any, env as any);

      const rows = await env.DB.prepare('SELECT spotify_id FROM tracks WHERE artist_id = ?').bind('local-1').all<any>();
      expect(rows.results.map((r: any) => r.spotify_id).sort()).toEqual(makeTracks(10).map((t) => t.id).sort());
      vi.unstubAllGlobals();
    });

    it('is unaffected by an active app-wide Spotify cooldown flag -- interactive priority is exempt from the background admission check', async () => {
      const albumsCallCount = stubTrackSearchCounting(makeTracks(5));
      await env.RATE_LIMIT_KV.put('spotify-cooldown', String(Date.now() + 10000));
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });

      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();

      expect(res.status).toBe(200);
      expect(body.tracks.length).toBeGreaterThan(0);
      expect(albumsCallCount()).toBeGreaterThan(0); // it actually called Spotify, not skipped
      vi.unstubAllGlobals();
    });

    it('the ?limit= "Load more" path (fetchArtistTracksCached) is also unaffected by an active cooldown flag', async () => {
      stubTrackSearch({ tracks: makeTracks(10) });
      await env.RATE_LIMIT_KV.put('spotify-cooldown', String(Date.now() + 10000));
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1?limit=10', { headers: { Cookie: cookie } });

      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();

      expect(res.status).toBe(200);
      expect(body.tracks.length).toBeGreaterThan(0);
      vi.unstubAllGlobals();
    });

    it('marks the app-wide cooldown flag when the quick path itself hits a 429 -- the exact call site (GET /v1/albums/{id}/tracks?limit=5) the original production Sentry error came from', async () => {
      let albumTracksCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo) => {
          const url = input.toString();
          if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
          if (url.includes('/artists/') && url.includes('/albums')) {
            return new Response(JSON.stringify({ items: [{ id: 'album-1', images: [] }] }), { status: 200 });
          }
          if (url.includes('/albums/album-1/tracks')) {
            albumTracksCalls += 1;
            if (albumTracksCalls === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
            return new Response(
              JSON.stringify({ items: [{ id: 'trk0', name: 'Track', preview_url: null, artists: [{ id: 'spotify-local-1', name: 'Local Artist' }] }] }),
              { status: 200 }
            );
          }
          throw new Error(`unexpected ${url}`);
        })
      );
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });

      const res = await worker.fetch(req, env, {} as ExecutionContext);

      expect(res.status).toBe(200); // spotifyFetch's own retry succeeds -- the user never sees this
      expect(await env.RATE_LIMIT_KV.get('spotify-cooldown')).not.toBeNull();
      vi.unstubAllGlobals();
    }, 5000);
  });
});

describe('POST /api/artists', () => {
  it('validates against Spotify and inserts with source spotify_search', async () => {
    stubSpotify();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/artists', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyArtistId: 'new-artist' }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('new-artist').first<any>();
    expect(row.source).toBe('spotify_search');
    expect(row.approved).toBe(1);
    expect(row.added_by_user_id).toBe('u1');

    const genreRow = await env.DB.prepare('SELECT * FROM genres WHERE genre = ?').bind('indie').first<any>();
    expect(genreRow.artist_count).toBe(1);

    vi.unstubAllGlobals();
  });

  it('does not double-count the catalog genres table when the same artist is added twice', async () => {
    stubSpotify();
    const cookie = await cookieFor('u1');
    const post = () =>
      worker.fetch(
        new Request('http://localhost/api/artists', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ spotifyArtistId: 'new-artist' }),
        }),
        env,
        {} as ExecutionContext
      );

    await post();
    await post(); // second POST hits the DB-first short-circuit below -- must not double-count

    const genreRow = await env.DB.prepare('SELECT * FROM genres WHERE genre = ?').bind('indie').first<any>();
    expect(genreRow.artist_count).toBe(1);

    vi.unstubAllGlobals();
  });

  it('does not call Spotify at all when the artist is already cataloged (DB-first)', async () => {
    // local-1 is already seeded (beforeEach) -- any fetch at all here means
    // the DB-first short-circuit didn't fire.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      throw new Error(`Spotify should not have been called: ${input.toString()}`);
    }));
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/artists', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyArtistId: 'spotify-local-1' }),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(res.status).toBe(200);
    expect(body.artistId).toBe('local-1');
    vi.unstubAllGlobals();
  });
});

describe('POST /api/tracks', () => {
  it('returns 400 (not an uncaught exception) for an unknown artistId and inserts nothing', async () => {
    stubSpotify();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/tracks', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyTrackId: 'some-track', artistId: 'does-not-exist' }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('unknown artist_id');
    const row = await env.DB.prepare('SELECT * FROM tracks WHERE spotify_id = ?').bind('some-track').first<any>();
    expect(row).toBeNull();
    vi.unstubAllGlobals();
  });

  it('inserts the track and records its genres under the artist\'s genres in the catalog table', async () => {
    // 'local-1' (seeded in beforeEach) has genres {"pop":true} -- tracks don't
    // carry their own genres, so a new track attributes to its artist's.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('/v1/tracks/new-track')) {
          return new Response(JSON.stringify({ id: 'new-track', name: 'New Track', album: { images: [] }, preview_url: null }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/tracks', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyTrackId: 'new-track', artistId: 'local-1' }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT * FROM tracks WHERE spotify_id = ?').bind('new-track').first<any>();
    expect(row).not.toBeNull();
    expect(row.artist_id).toBe('local-1');

    const genreRow = await env.DB.prepare('SELECT * FROM genres WHERE genre = ?').bind('pop').first<any>();
    expect(genreRow.track_count).toBe(1);

    vi.unstubAllGlobals();
  });

  it('does not call Spotify at all when the track is already cataloged (DB-first)', async () => {
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, source, approved, created_at, updated_at) VALUES ('existing-trk', 'trk1', 'Track One', 'local-1', 'seed', 1, 1000, 1000)`
    ).run();
    // Any fetch at all here means the DB-first short-circuit didn't fire.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      throw new Error(`Spotify should not have been called: ${input.toString()}`);
    }));
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/tracks', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyTrackId: 'trk1', artistId: 'local-1' }),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(res.status).toBe(200);
    expect(body.trackId).toBe('existing-trk');
    vi.unstubAllGlobals();
  });
});
