import { describe, it, expect, vi } from 'vitest';
import {
  buildAuthUrl,
  fetchSpotifyProfile,
  fetchArtistTracks,
  fetchArtistTracksQuick,
  QUICK_TRACK_LIMIT,
  fetchArtistById,
  fetchTrackById,
  searchArtistsByGenre,
  SpotifyRateLimitError,
  SpotifyCooldownActiveError,
} from '../../src/lib/spotify';

const env = {
  SPOTIFY_CLIENT_ID: 'client123',
  SPOTIFY_REDIRECT_URI: 'http://localhost:8787/callback',
} as any;

function fakeKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

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
    // Required for Spotify's /v1/me response to include `product` at all --
    // without it, player.ts's premium gate silently fails for every account
    // regardless of actual tier. Regression coverage for that bug.
    expect(url.searchParams.get('scope')).toContain('user-read-private');
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

  it('bounds album-tracks fetches to ALBUM_TRACKS_FETCH_CONCURRENCY instead of firing them all at once', async () => {
    // Regression: this fan-out (up to ARTIST_ALBUMS_PAGE_SIZE albums, 10) used
    // to fire every album-tracks call in one simultaneous Promise.all, just
    // like fetchTracksByIds did before TRACK_FETCH_CONCURRENCY. 8 albums here
    // (more than the concurrency cap of 5) proves the cap is real.
    const albumIds = Array.from({ length: 8 }, (_, i) => `album-${i}`);
    let inFlight = 0;
    let maxConcurrent = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: albumIds.map((id) => ({ id })) }), { status: 200 });
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

    expect(maxConcurrent).toBe(5);
    vi.unstubAllGlobals();
  });

  it('bounds individual track-detail fetches to TRACK_FETCH_CONCURRENCY instead of firing them all at once', async () => {
    // Regression: this was the single biggest contributor to tripping
    // Spotify's own app-wide rate limit -- a full artist load (up to
    // ARTIST_PROFILE_TRACK_MAX_LIMIT tracks) used to fire every individual
    // GET /v1/tracks/{id} call in one simultaneous Promise.all. 8 tracks
    // here (more than TRACK_FETCH_CONCURRENCY's 5) is enough to prove the
    // cap is real without a slow test.
    const trackIds = Array.from({ length: 8 }, (_, i) => `t${i}`);
    let inFlight = 0;
    let maxConcurrent = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: [{ id: 'album-1' }] }), { status: 200 });
        }
        if (url.includes('/albums/album-1/tracks')) {
          return new Response(JSON.stringify({ items: trackIds.map((id) => ({ id })) }), { status: 200 });
        }
        if (url.includes('/v1/tracks/')) {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          const id = url.match(/\/v1\/tracks\/([^/?]+)$/)![1];
          return new Response(JSON.stringify({ id, name: id, artists: [{ id: 'artist-1' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    const tracks = await fetchArtistTracks('token', 'artist-1', 8);

    expect(tracks).toHaveLength(8);
    expect(maxConcurrent).toBe(5);
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

  it('throws SpotifyCooldownActiveError, without making any Spotify call, when background priority is used during an active cooldown', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const kv = fakeKv({ 'spotify-cooldown': String(Date.now() + 10000) });

    await expect(fetchArtistTracks('token', 'artist-1', 10, 'background', kv)).rejects.toThrow(SpotifyCooldownActiveError);

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('proceeds normally with background priority when there is no active cooldown', async () => {
    stubSpotify({
      albums: [{ id: 'album-1' }],
      albumTracks: { 'album-1': [{ id: 't1' }] },
      tracksById: { t1: { id: 't1', name: 'Track One', artists: [{ id: 'artist-1' }] } },
    });
    const kv = fakeKv();

    const tracks = await fetchArtistTracks('token', 'artist-1', 10, 'background', kv);

    expect(tracks.map((t: any) => t.id)).toEqual(['t1']);
    vi.unstubAllGlobals();
  });

  it('interactive priority ignores an active cooldown entirely and still fetches', async () => {
    stubSpotify({
      albums: [{ id: 'album-1' }],
      albumTracks: { 'album-1': [{ id: 't1' }] },
      tracksById: { t1: { id: 't1', name: 'Track One', artists: [{ id: 'artist-1' }] } },
    });
    const kv = fakeKv({ 'spotify-cooldown': String(Date.now() + 10000) });

    const tracks = await fetchArtistTracks('token', 'artist-1', 10, 'interactive', kv);

    expect(tracks.map((t: any) => t.id)).toEqual(['t1']);
    vi.unstubAllGlobals();
  });

  it('background priority stops fetching further albums once enough track ids are already gathered', async () => {
    // 8 albums, each with 10 tracks -- the first ALBUM_TRACKS_FETCH_CONCURRENCY
    // (5) albums alone already yield 50 track ids, well past a limit of 30,
    // so the remaining 3 albums' track-lists should never be requested.
    const albumIds = Array.from({ length: 8 }, (_, i) => `album-${i}`);
    const albumTrackCalls = new Set<string>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: albumIds.map((id) => ({ id })) }), { status: 200 });
        }
        const albumMatch = url.match(/\/albums\/([^/?]+)\/tracks/);
        if (albumMatch) {
          albumTrackCalls.add(albumMatch[1]);
          const tracks = Array.from({ length: 10 }, (_, i) => ({ id: `${albumMatch[1]}-t${i}` }));
          return new Response(JSON.stringify({ items: tracks }), { status: 200 });
        }
        if (url.includes('/v1/tracks/')) {
          const id = url.match(/\/v1\/tracks\/([^/?]+)$/)![1];
          return new Response(JSON.stringify({ id, name: id, artists: [{ id: 'artist-1' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );
    const kv = fakeKv();

    await fetchArtistTracks('token', 'artist-1', 30, 'background', kv);

    expect(albumTrackCalls.size).toBe(5); // not all 8
    vi.unstubAllGlobals();
  }, 10000);

  it("interactive priority still fetches every album's track-list up front (regression check against the background-only early-stop)", async () => {
    const albumIds = Array.from({ length: 8 }, (_, i) => `album-${i}`);
    const albumTrackCalls = new Set<string>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: albumIds.map((id) => ({ id })) }), { status: 200 });
        }
        const albumMatch = url.match(/\/albums\/([^/?]+)\/tracks/);
        if (albumMatch) {
          albumTrackCalls.add(albumMatch[1]);
          const tracks = Array.from({ length: 10 }, (_, i) => ({ id: `${albumMatch[1]}-t${i}` }));
          return new Response(JSON.stringify({ items: tracks }), { status: 200 });
        }
        if (url.includes('/v1/tracks/')) {
          const id = url.match(/\/v1\/tracks\/([^/?]+)$/)![1];
          return new Response(JSON.stringify({ id, name: id, artists: [{ id: 'artist-1' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    await fetchArtistTracks('token', 'artist-1', 30);

    expect(albumTrackCalls.size).toBe(8); // all of them, unlike background priority
    vi.unstubAllGlobals();
  }, 10000);

  it('paces background-priority calls with a delay, unlike interactive priority', async () => {
    const albumIds = ['album-1', 'album-2', 'album-3', 'album-4', 'album-5', 'album-6'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: albumIds.map((id) => ({ id })) }), { status: 200 });
        }
        if (url.includes('/albums/')) {
          // Each album has just 1 track, so even the first 5-album chunk
          // alone (5 tracks) doesn't satisfy a limit of 10 -- forces a
          // second chunk, which is where the pacing delay applies.
          const albumMatch = url.match(/\/albums\/([^/?]+)\/tracks/)!;
          return new Response(JSON.stringify({ items: [{ id: `${albumMatch[1]}-t1` }] }), { status: 200 });
        }
        if (url.includes('/v1/tracks/')) {
          const id = url.match(/\/v1\/tracks\/([^/?]+)$/)![1];
          return new Response(JSON.stringify({ id, name: id, artists: [{ id: 'artist-1' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );
    const kv = fakeKv();

    const start = Date.now();
    await fetchArtistTracks('token', 'artist-1', 10, 'background', kv);
    const elapsed = Date.now() - start;

    // SPOTIFY_BACKGROUND_PACING_DELAY_MS = 250 -- at least one pacing wait
    // fires (between the two album-list chunks, and/or in the track-detail
    // phase), so elapsed time should clear a meaningful fraction of one delay.
    expect(elapsed).toBeGreaterThanOrEqual(240);
    vi.unstubAllGlobals();
  }, 10000);

  it('applies no pacing delay for interactive priority', async () => {
    stubSpotify({
      albums: [{ id: 'album-1' }],
      albumTracks: { 'album-1': [{ id: 't1' }] },
      tracksById: { t1: { id: 't1', name: 'Track One', artists: [{ id: 'artist-1' }] } },
    });

    const start = Date.now();
    await fetchArtistTracks('token', 'artist-1', 10);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
    vi.unstubAllGlobals();
  });
});

describe('fetchArtistTracksQuick', () => {
  it('only asks for the single most recent album, and only up to QUICK_TRACK_LIMIT tracks from it -- not the full ~40-call fan-out', async () => {
    const albumsCalls: string[] = [];
    let albumTracksCallUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          albumsCalls.push(url);
          return new Response(JSON.stringify({ items: [{ id: 'album-1' }, { id: 'album-2' }] }), { status: 200 });
        }
        if (url.includes('/albums/album-1/tracks')) {
          albumTracksCallUrl = url;
          return new Response(JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}` })) }), { status: 200 });
        }
        if (url.includes('/v1/tracks/')) {
          const id = url.match(/\/v1\/tracks\/([^/?]+)$/)![1];
          return new Response(JSON.stringify({ id, name: id, artists: [{ id: 'artist-1', name: 'X' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    const tracks = await fetchArtistTracksQuick('token', 'artist-1');

    // Only the albums endpoint's own ?limit= reflects the single-album
    // request; the actual returned array length is what matters for call
    // count -- fetchAlbumTrackIds is only ever called once (for album-1),
    // never album-2.
    expect(albumsCalls).toHaveLength(1);
    expect(new URL(albumsCalls[0]).searchParams.get('limit')).toBe('1');
    expect(new URL(albumTracksCallUrl).searchParams.get('limit')).toBe(String(QUICK_TRACK_LIMIT));
    expect(tracks).toHaveLength(QUICK_TRACK_LIMIT);
    vi.unstubAllGlobals();
  });

  it('truncates client-side to QUICK_TRACK_LIMIT even if the album-tracks response ignores ?limit= and returns more', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: [{ id: 'album-1' }] }), { status: 200 });
        }
        if (url.includes('/albums/album-1/tracks')) {
          // Deliberately ignores the requested limit, like a naive test
          // double (or a misbehaving real response) might.
          return new Response(JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: `t${i}` })) }), { status: 200 });
        }
        if (url.includes('/v1/tracks/')) {
          const id = url.match(/\/v1\/tracks\/([^/?]+)$/)![1];
          return new Response(JSON.stringify({ id, name: id, artists: [{ id: 'artist-1', name: 'X' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    const tracks = await fetchArtistTracksQuick('token', 'artist-1');

    expect(tracks).toHaveLength(QUICK_TRACK_LIMIT);
    vi.unstubAllGlobals();
  });

  it('returns fewer than QUICK_TRACK_LIMIT without error when the artist\'s one album has fewer tracks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: [{ id: 'album-1' }] }), { status: 200 });
        }
        if (url.includes('/albums/album-1/tracks')) {
          return new Response(JSON.stringify({ items: [{ id: 't1' }, { id: 't2' }] }), { status: 200 });
        }
        if (url.includes('/v1/tracks/')) {
          const id = url.match(/\/v1\/tracks\/([^/?]+)$/)![1];
          return new Response(JSON.stringify({ id, name: id, artists: [{ id: 'artist-1', name: 'X' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    const tracks = await fetchArtistTracksQuick('token', 'artist-1');

    expect(tracks).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it('returns no tracks, and makes no track-detail calls, when the artist has no albums at all', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('/artists/') && url.includes('/albums')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    const tracks = await fetchArtistTracksQuick('token', 'artist-1');

    expect(tracks).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // just the albums call, nothing more
    vi.unstubAllGlobals();
  });

  it('filters out a track credited to a different artist, same defensive check as fetchArtistTracks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: [{ id: 'album-1' }] }), { status: 200 });
        }
        if (url.includes('/albums/album-1/tracks')) {
          return new Response(JSON.stringify({ items: [{ id: 't1' }] }), { status: 200 });
        }
        if (url.includes('/v1/tracks/t1')) {
          return new Response(JSON.stringify({ id: 't1', name: 'Wrong Credit', artists: [{ id: 'someone-else' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    const tracks = await fetchArtistTracksQuick('token', 'artist-1');

    expect(tracks).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('forwards kv through to spotifyFetch so a 429 still marks cooldown, even though quick fetch never checks it (always interactive)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: [{ id: 'album-1' }] }), { status: 200 });
        }
        if (url.includes('/albums/album-1/tracks')) {
          calls += 1;
          if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );
    const kv = fakeKv();

    await fetchArtistTracksQuick('token', 'artist-1', kv);

    expect(await kv.get('spotify-cooldown')).not.toBeNull();
    vi.unstubAllGlobals();
  }, 5000);

  it('still ignores an active cooldown and fetches anyway -- quick fetch is always interactive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: [{ id: 'album-1' }] }), { status: 200 });
        }
        if (url.includes('/albums/album-1/tracks')) {
          return new Response(JSON.stringify({ items: [{ id: 't1' }] }), { status: 200 });
        }
        if (url.includes('/v1/tracks/t1')) {
          return new Response(JSON.stringify({ id: 't1', name: 'Track One', artists: [{ id: 'artist-1' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );
    const kv = fakeKv({ 'spotify-cooldown': String(Date.now() + 10000) });

    const tracks = await fetchArtistTracksQuick('token', 'artist-1', kv);

    expect(tracks).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

describe('searchArtistsByGenre', () => {
  it("returns Spotify's results when there is no active cooldown", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ artists: { items: [{ id: 'a1', name: 'Artist One' }] } }), { status: 200 }))
    );
    const kv = fakeKv();

    const artists = await searchArtistsByGenre('token', 'indie', 10, 0, kv);

    expect(artists).toEqual([{ id: 'a1', name: 'Artist One' }]);
    vi.unstubAllGlobals();
  });

  it('throws SpotifyCooldownActiveError, without making any Spotify call, during an active cooldown', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const kv = fakeKv({ 'spotify-cooldown': String(Date.now() + 10000) });

    await expect(searchArtistsByGenre('token', 'indie', 10, 0, kv)).rejects.toThrow(SpotifyCooldownActiveError);

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// Exercised via fetchArtistById (a single, simple call) rather than testing
// the unexported spotifyFetch directly -- every Spotify call in this module
// goes through it, so any of them would do.
describe('spotifyFetch (retry-on-429, via fetchArtistById)', () => {
  it('retries once on a 429, honoring a fractional Retry-After, and returns the retried response', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          // A tiny fractional value keeps this test fast -- real Spotify
          // only ever sends whole seconds, but the parsing logic doesn't
          // care, and this proves the header is actually being read (a
          // bug that ignored it and always used the 1s default would still
          // pass a test using a header value >= 1).
          return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.001' } });
        }
        return new Response(JSON.stringify({ id: 'artist-1', name: 'Real Artist' }), { status: 200 });
      })
    );

    const artist = await fetchArtistById('token', 'artist-1');

    expect(artist.name).toBe('Real Artist');
    expect(calls).toBe(2);
    vi.unstubAllGlobals();
  });

  it('falls back to a default delay when Retry-After is absent, still succeeding on the retry', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Response('rate limited', { status: 429 });
        return new Response(JSON.stringify({ id: 'artist-1', name: 'Real Artist' }), { status: 200 });
      })
    );

    const artist = await fetchArtistById('token', 'artist-1');

    expect(artist.name).toBe('Real Artist');
    expect(calls).toBe(2);
    vi.unstubAllGlobals();
  }, 10000);

  it('retries multiple times (not just once) before giving up, succeeding on a later attempt', async () => {
    // Regression: a single retry wasn't enough runway to clear Spotify's own
    // rate-limit window under real production load -- "Spotify's a little
    // busy" kept appearing even after that one retry. Succeeding on the 3rd
    // attempt (2 retries) proves this isn't capped back down to one.
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls < 3) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.001' } });
        return new Response(JSON.stringify({ id: 'artist-1', name: 'Real Artist' }), { status: 200 });
      })
    );

    const artist = await fetchArtistById('token', 'artist-1');

    expect(artist.name).toBe('Real Artist');
    expect(calls).toBe(3);
    vi.unstubAllGlobals();
  });

  it('throws SpotifyRateLimitError, not the generic fetch-failed Error, when still 429 after every retry', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.001' } });
      })
    );

    await expect(fetchArtistById('token', 'artist-1')).rejects.toThrow(SpotifyRateLimitError);
    // 1 initial attempt + SPOTIFY_MAX_RETRIES (3) retries.
    expect(calls).toBe(4);

    vi.unstubAllGlobals();
  });

  it('does not retry on a non-429 error status', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return new Response('not found', { status: 404 });
      })
    );

    await expect(fetchArtistById('token', 'artist-1')).rejects.toThrow(/Spotify artist fetch failed: 404/);
    expect(calls).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('spotifyFetch structured call logging (via fetchArtistById)', () => {
  it('logs a structured spotify_call entry for a successful call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'artist-1', name: 'Real Artist' }), { status: 200 }))
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await fetchArtistById('token', 'artist-1');

    const call = logSpy.mock.calls.find(([entry]) => entry?.type === 'spotify_call');
    expect(call).toBeDefined();
    const [entry] = call!;
    expect(entry.url).toBe('https://api.spotify.com/v1/artists/artist-1');
    expect(entry.method).toBe('GET');
    expect(entry.status).toBe(200);
    expect(entry.attempts).toBe(1);
    expect(entry.rateLimited).toBe(false);
    expect(typeof entry.durationMs).toBe('number');
    logSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('logs attempts > 1 and rateLimited: true when the call retries through a 429 before succeeding', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.001' } });
        return new Response(JSON.stringify({ id: 'artist-1', name: 'Real Artist' }), { status: 200 });
      })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await fetchArtistById('token', 'artist-1');

    const [entry] = logSpy.mock.calls.find(([e]) => e?.type === 'spotify_call')!;
    expect(entry.attempts).toBe(2);
    expect(entry.rateLimited).toBe(true);
    expect(entry.status).toBe(200);
    logSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('still logs the call, with the final 429 status, when every retry is exhausted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.001' } }))
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(fetchArtistById('token', 'artist-1')).rejects.toThrow(SpotifyRateLimitError);

    const [entry] = logSpy.mock.calls.find(([e]) => e?.type === 'spotify_call')!;
    expect(entry.status).toBe(429);
    expect(entry.attempts).toBe(4); // 1 initial + 3 retries
    expect(entry.rateLimited).toBe(true);
    logSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});

// A separate block from the one above (which exercises retry behavior via
// fetchArtistById, a function that never gets a kv param) -- kv-forwarding
// and cooldown-marking are new behavior only reachable through the
// functions in this file that DO take kv, and fetchTrackById is the
// simplest of those.
describe('spotifyFetch cooldown-marking on 429 (via fetchTrackById)', () => {
  it('marks the cooldown flag, honoring Retry-After (not falling back to the default), when a kv is provided and a 429 occurs', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
        return new Response(JSON.stringify({ id: 'track-1', name: 'Song', artists: [] }), { status: 200 });
      })
    );
    const kv = fakeKv();
    const before = Date.now();

    await fetchTrackById('token', 'track-1', kv);

    const stored = await kv.get('spotify-cooldown');
    expect(stored).not.toBeNull();
    const expiresInFromBefore = Number(stored) - before;
    // Retry-After: 1s should drive this to ~1s out from `before`, clearly
    // distinct from SPOTIFY_COOLDOWN_DEFAULT_SECONDS (15s) -- proving the
    // header value was actually read, not the fallback used.
    expect(expiresInFromBefore).toBeGreaterThan(500);
    expect(expiresInFromBefore).toBeLessThan(10000);
    vi.unstubAllGlobals();
  }, 5000);

  it('does not touch KV at all when no kv is provided -- existing (pre-throttle) call sites are unaffected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.001' } }))
    );
    const kv = fakeKv();
    const putSpy = vi.spyOn(kv, 'put');

    await expect(fetchTrackById('token', 'track-1')).rejects.toThrow(SpotifyRateLimitError);

    expect(putSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not mark cooldown on a successful (non-429) response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'track-1', name: 'Song', artists: [] }), { status: 200 }))
    );
    const kv = fakeKv();

    await fetchTrackById('token', 'track-1', kv);

    expect(await kv.get('spotify-cooldown')).toBeNull();
    vi.unstubAllGlobals();
  });
});
