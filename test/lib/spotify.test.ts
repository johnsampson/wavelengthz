import { describe, it, expect, vi } from 'vitest';
import { buildAuthUrl, fetchSpotifyProfile, fetchArtistTracks } from '../../src/lib/spotify';

const env = {
  SPOTIFY_CLIENT_ID: 'client123',
  SPOTIFY_REDIRECT_URI: 'http://localhost:8787/callback',
} as any;

describe('buildAuthUrl', () => {
  it('builds a Spotify authorize URL with client id, redirect uri, scope, and state', () => {
    const url = new URL(buildAuthUrl('state-abc', env));
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('client123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('scope')).toContain('user-top-read');
    expect(url.searchParams.get('scope')).toContain('user-read-email');
  });
});

describe('fetchSpotifyProfile', () => {
  it('passes through the images array from Spotify\'s /v1/me response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ id: 'sp1', email: 'a@b.com', images: [{ url: 'https://img.example/avatar.jpg' }] }),
          { status: 200 }
        )
      )
    );
    const profile = await fetchSpotifyProfile('token');
    expect(profile.images?.[0]?.url).toBe('https://img.example/avatar.jpg');
    vi.unstubAllGlobals();
  });

  it('handles a profile with no images', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'sp1' }), { status: 200 })));
    const profile = await fetchSpotifyProfile('token');
    expect(profile.images).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe('fetchArtistTracks', () => {
  function stubSpotify({ albums = [], albumTracks = {}, tracksById = {} }: { albums?: any[]; albumTracks?: Record<string, any[]>; tracksById?: Record<string, any> }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: albums }), { status: 200 });
        }
        const albumTracksMatch = url.match(/\/albums\/([^/?]+)\/tracks/);
        if (albumTracksMatch) {
          return new Response(JSON.stringify({ items: albumTracks[albumTracksMatch[1]] ?? [] }), { status: 200 });
        }
        const trackByIdMatch = url.match(/\/v1\/tracks\/([^/?]+)$/);
        if (trackByIdMatch) {
          const track = tracksById[trackByIdMatch[1]];
          return track ? new Response(JSON.stringify(track), { status: 200 }) : new Response('not found', { status: 404 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );
  }

  it("fetches an artist's own tracks via their albums, with full track details", async () => {
    // GET /v1/artists/{id}/top-tracks is 403'd in Development Mode (see the
    // comment above fetchArtistAlbumIds in spotify.ts), and the previous
    // name-search fallback could come back completely empty for a real
    // artist whose name overlaps a more famous identity (verified live for
    // "Cirez D", Eric Prydz's alias). Going via albums -> album tracks is
    // id-scoped end to end, so there's no name ambiguity to get wrong.
    stubSpotify({
      albums: [{ id: 'album-1' }],
      albumTracks: { 'album-1': [{ id: 't1' }, { id: 't2' }] },
      tracksById: {
        t1: { id: 't1', name: 'Valborg', artists: [{ id: 'artist-1', name: 'Cirez D' }] },
        t2: { id: 't2', name: 'The Raid', artists: [{ id: 'artist-1', name: 'Cirez D' }] },
      },
    });

    const tracks = await fetchArtistTracks('token', 'artist-1', 10);

    expect(tracks.map((t: any) => t.name)).toEqual(['Valborg', 'The Raid']);
    vi.unstubAllGlobals();
  });

  it("never asks Spotify for more albums than its real max (10), even when the caller's own limit is much higher", async () => {
    // Spotify's documented max for GET /v1/artists/{id}/albums's `limit` is
    // 10 -- requesting more than that 400s outright. A higher target track
    // count (e.g. the artist-profile route's 30) must still cap this
    // specific call at 10, drawing more tracks per album instead.
    let albumsCallUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          albumsCallUrl = url;
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    await fetchArtistTracks('token', 'artist-1', 30);

    expect(new URL(albumsCallUrl).searchParams.get('limit')).toBe('10');
    vi.unstubAllGlobals();
  });

  it("never asks Spotify for more tracks from one album than its real max (50), even when the caller's own limit is higher", async () => {
    let albumTracksCallUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: [{ id: 'album-1' }] }), { status: 200 });
        }
        if (url.includes('/albums/album-1/tracks')) {
          albumTracksCallUrl = url;
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    await fetchArtistTracks('token', 'artist-1', 60);

    expect(new URL(albumTracksCallUrl).searchParams.get('limit')).toBe('50');
    vi.unstubAllGlobals();
  });

  it('fetches album-tracks for every returned album concurrently rather than one at a time', async () => {
    // Latency, not correctness: with no batch endpoint available, a
    // sequential loop over up to 10 albums would add one Spotify round trip
    // per album directly to the artist-profile page's load time. Asserting
    // that both albums' track-id lookups are in flight before either
    // resolves is the only reliable way to catch a regression back to a
    // sequential loop -- checking the final result alone can't tell the
    // difference.
    let inFlight = 0;
    let maxConcurrent = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: [{ id: 'album-1' }, { id: 'album-2' }] }), { status: 200 });
        }
        if (url.includes('/albums/')) {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    await fetchArtistTracks('token', 'artist-1', 10);

    expect(maxConcurrent).toBe(2);
    vi.unstubAllGlobals();
  });

  it('excludes any track that does not actually credit the requested artist id', async () => {
    stubSpotify({
      albums: [{ id: 'album-1' }],
      albumTracks: { 'album-1': [{ id: 't1' }, { id: 't2' }] },
      tracksById: {
        t1: { id: 't1', name: 'Right Song', artists: [{ id: 'artist-1', name: 'Real Artist' }] },
        t2: { id: 't2', name: 'Wrong Song', artists: [{ id: 'artist-2', name: 'Someone Else' }] },
      },
    });

    const tracks = await fetchArtistTracks('token', 'artist-1', 10);

    expect(tracks.map((t: any) => t.id)).toEqual(['t1']);
    vi.unstubAllGlobals();
  });

  it('truncates to the requested limit, preferring earlier (more recent) albums, without fetching full details for truncated-away tracks', async () => {
    // Album-tracks lookups now fan out in parallel across every returned
    // album rather than stopping early -- fewer sequential round trips is
    // worth a few tracks' worth of ids fetched and then discarded. Full
    // per-track detail lookups (the expensive, one-request-per-track step)
    // only ever happen for tracks that survive the limit=1 truncation, so
    // t2's own detail endpoint should never be called.
    const trackDetailCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: [{ id: 'album-1' }, { id: 'album-2' }] }), { status: 200 });
        }
        if (url.includes('/albums/album-1/tracks')) {
          return new Response(JSON.stringify({ items: [{ id: 't1' }] }), { status: 200 });
        }
        if (url.includes('/albums/album-2/tracks')) {
          return new Response(JSON.stringify({ items: [{ id: 't2' }] }), { status: 200 });
        }
        if (url.includes('/v1/tracks/')) {
          trackDetailCalls.push(url);
          return new Response(JSON.stringify({ id: 't1', name: 'Track One', artists: [{ id: 'artist-1', name: 'X' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    const tracks = await fetchArtistTracks('token', 'artist-1', 1);

    expect(tracks).toHaveLength(1);
    expect(trackDetailCalls).toEqual([expect.stringContaining('/v1/tracks/t1')]);
    vi.unstubAllGlobals();
  });

  it('returns no tracks when the artist has no albums', async () => {
    stubSpotify({ albums: [] });

    const tracks = await fetchArtistTracks('token', 'artist-1', 10);

    expect(tracks).toEqual([]);
    vi.unstubAllGlobals();
  });
});
