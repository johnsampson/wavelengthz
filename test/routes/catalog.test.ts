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
  await env.DB.exec('DELETE FROM sessions; DELETE FROM tracks; DELETE FROM artists; DELETE FROM users;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('local-1', 'Local Artist', '["pop"]', 'seed', 1, 1000)`
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
});
