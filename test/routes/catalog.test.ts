import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  // Children before parents: tracks/artists reference users via added_by_user_id,
  // and tracks references artists — deleting users/artists first trips the FK constraint
  // once a prior test has left a row with a non-null reference.
  await env.DB.exec('DELETE FROM genres; DELETE FROM music_swipes; DELETE FROM sessions; DELETE FROM tracks; DELETE FROM artists; DELETE FROM users;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('local-1', 'Local Artist', '{"pop":true}', 'seed', 1, 1000)`
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
    const fresh = body.results.find((r: any) => r.id === 'new-artist');
    expect(local.inCatalog).toBe(true);
    expect(local.genres).toEqual(['pop']); // stored as {pop: true} on the row, exposed as an array
    expect(fresh.inCatalog).toBe(false);
    vi.unstubAllGlobals();
  });

  it('dedupes an artist that appears in both the local catalog and the live Spotify results', async () => {
    // Stub Spotify's artist search to return the SAME id already seeded locally ('local-1'),
    // simulating the case where a catalog artist also matches the live search.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('/v1/search') && url.includes('type=artist')) {
          return new Response(
            JSON.stringify({
              artists: { items: [{ id: 'local-1', name: 'Local Artist', genres: ['pop'], images: [], popularity: 40 }] },
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
  // The dedicated "top tracks" endpoint is 403'd for this app (see the
  // comment on searchTracksByArtistName), so the artist-profile route falls
  // back to /v1/search?type=track -- shape is { tracks: { items: [...] } },
  // not { tracks: [...] }.
  function stubTrackSearch(trackSearchResponse: any, extra?: (url: string) => Response | null) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('/v1/search') && url.includes('type=track')) {
          return new Response(JSON.stringify({ tracks: { items: trackSearchResponse.tracks } }), { status: 200 });
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
        { id: 'trk1', name: 'Track One', album: { images: [{ url: 'https://img.example/trk1.jpg' }] }, preview_url: 'https://prev/trk1' },
        { id: 'trk2', name: 'Track Two', album: { images: [] }, preview_url: null },
      ],
    });
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();

    expect(body.artist.id).toBe('local-1');
    expect(body.artist.genres).toEqual(['pop']);
    expect(body.tracks.map((t: any) => t.id)).toEqual(['trk1', 'trk2']);
    expect(body.tracks[0].imageUrl).toBe('https://img.example/trk1.jpg');
    expect(body.tracks[0].direction).toBeNull();

    const row = await env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind('trk1').first<any>();
    expect(row).not.toBeNull();
    expect(row.artist_id).toBe('local-1');

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
    const req = new Request('http://localhost/api/artists/new-artist', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.artist.name).toBe('New Artist');
    expect(body.artist.genres).toEqual(['indie']);

    const row = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind('new-artist').first<any>();
    expect(row.source).toBe('spotify_search');

    const genreRow = await env.DB.prepare('SELECT * FROM genres WHERE genre = ?').bind('indie').first<any>();
    expect(genreRow.artist_count).toBe(1);

    vi.unstubAllGlobals();
  });

  it('reports the current direction for a track the user already swiped on', async () => {
    stubTrackSearch({
      tracks: [{ id: 'trk1', name: 'Track One', album: { images: [] }, preview_url: null }],
    });
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'track', 'trk1', 'right', 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.tracks[0].direction).toBe('right');
    vi.unstubAllGlobals();
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
    const row = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind('new-artist').first<any>();
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
    await post(); // second POST hits INSERT OR IGNORE's no-op path -- must not double-count

    const genreRow = await env.DB.prepare('SELECT * FROM genres WHERE genre = ?').bind('indie').first<any>();
    expect(genreRow.artist_count).toBe(1);

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
    const row = await env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind('some-track').first<any>();
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

    const row = await env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind('new-track').first<any>();
    expect(row).not.toBeNull();
    expect(row.artist_id).toBe('local-1');

    const genreRow = await env.DB.prepare('SELECT * FROM genres WHERE genre = ?').bind('pop').first<any>();
    expect(genreRow.track_count).toBe(1);

    vi.unstubAllGlobals();
  });
});
