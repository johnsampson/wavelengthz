import { env } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../../src/index';

function stubSpotify({ tokenOk = true, artistOk = true, artistStatus = 200, retryAfter = null as number | null } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === 'https://accounts.spotify.com/api/token') {
        if (!tokenOk) return new Response('invalid_client', { status: 400 });
        return Response.json({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 });
      }
      if (url.startsWith('https://api.spotify.com/v1/artists/')) {
        if (artistStatus === 429) {
          const headers = new Headers();
          if (retryAfter != null) headers.set('Retry-After', String(retryAfter));
          return new Response('rate limited', { status: 429, headers });
        }
        if (!artistOk) return new Response('not found', { status: 404 });
        return Response.json({
          id: '3WrFJ7ztbogyGnTHbHJFl2',
          name: 'The Beatles',
          genres: ['rock'],
          popularity: 88,
          images: [{ url: 'https://img.example/beatles.jpg' }],
          external_urls: { spotify: 'https://open.spotify.com/artist/3WrFJ7ztbogyGnTHbHJFl2' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/spotify/connection-test', () => {
  it('requires no session -- works for a fully unauthenticated request', async () => {
    stubSpotify();
    const res = await worker.fetch(new Request('http://localhost/api/spotify/connection-test'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
  });

  it('returns the default well-known artist when no ?artistId= is given', async () => {
    stubSpotify();
    const res = await worker.fetch(new Request('http://localhost/api/spotify/connection-test'), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.ok).toBe(true);
    expect(body.artist.name).toBe('The Beatles');
    expect(body.artist.imageUrl).toBe('https://img.example/beatles.jpg');
    expect(body.artist.spotifyUrl).toContain('open.spotify.com');
  });

  it('never leaks the access token in the response', async () => {
    stubSpotify();
    const res = await worker.fetch(new Request('http://localhost/api/spotify/connection-test'), env, {} as ExecutionContext);
    const text = await res.text();
    expect(text).not.toContain('tok');
  });

  it('reports a clear failure (not a bare 500) when the client-credentials exchange fails', async () => {
    stubSpotify({ tokenOk: false });
    const res = await worker.fetch(new Request('http://localhost/api/spotify/connection-test'), env, {} as ExecutionContext);
    expect(res.status).toBe(502);
    const body = await res.json<any>();
    expect(body.ok).toBe(false);
    expect(body.step).toBe('client_credentials_token');
  });

  it('reports a clear failure when the artist id is not found', async () => {
    stubSpotify({ artistOk: false });
    const res = await worker.fetch(new Request('http://localhost/api/spotify/connection-test?artistId=doesnotexist'), env, {} as ExecutionContext);
    expect(res.status).toBe(502);
    const body = await res.json<any>();
    expect(body.ok).toBe(false);
    expect(body.step).toBe('get_artist');
  });

  it('surfaces a genuine Spotify rate-limit as the app-wide 503, distinct from a broken connection', async () => {
    stubSpotify({ artistStatus: 429, retryAfter: 120 });
    const res = await worker.fetch(new Request('http://localhost/api/spotify/connection-test'), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(res.status).toBe(503);
    expect(body.error).toBe('spotify_rate_limited');
  });
});
