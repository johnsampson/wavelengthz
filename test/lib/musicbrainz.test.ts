import { describe, it, expect, vi } from 'vitest';
import { lookupMusicBrainzArtistId, fetchMusicBrainzGenres, fetchGenreArtistCount } from '../../src/lib/musicbrainz';

describe('lookupMusicBrainzArtistId', () => {
  it('extracts the linked MBID from a matched Spotify-URL relationship', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            urls: [
              {
                resource: 'https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi',
                'relation-list': [{ relations: [{ artist: { id: '056e4f3e-d505-4dad-8ec1-d04f521cbb56', name: 'Daft Punk' } }] }],
              },
            ],
          }),
          { status: 200 }
        )
      )
    );

    const mbid = await lookupMusicBrainzArtistId('4tZwfgrHOc3mvqYlEYSvVi');

    expect(mbid).toBe('056e4f3e-d505-4dad-8ec1-d04f521cbb56');
    vi.unstubAllGlobals();
  });

  it('sends a descriptive User-Agent header, per MusicBrainz API etiquette', async () => {
    let sentHeaders: Headers | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
        sentHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ urls: [] }), { status: 200 });
      })
    );

    await lookupMusicBrainzArtistId('anyid');

    expect(sentHeaders?.get('User-Agent')).toMatch(/^Wavelengthz\/.+\(.+\)$/);
    vi.unstubAllGlobals();
  });

  it('returns null when no url entity matches (no MusicBrainz link exists yet)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ urls: [] }), { status: 200 })));

    const mbid = await lookupMusicBrainzArtistId('unlinked-artist-id');

    expect(mbid).toBeNull();
    vi.unstubAllGlobals();
  });

  it('returns null when a url entity matches but carries no artist relation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ urls: [{ resource: 'https://open.spotify.com/artist/x', 'relation-list': [{ relations: [] }] }] }),
          { status: 200 }
        )
      )
    );

    const mbid = await lookupMusicBrainzArtistId('x');

    expect(mbid).toBeNull();
    vi.unstubAllGlobals();
  });

  it('throws with the response body on a non-OK response, matching this codebase\'s other API clients', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 503 })));

    await expect(lookupMusicBrainzArtistId('x')).rejects.toThrow(/503/);
    vi.unstubAllGlobals();
  });
});

describe('fetchMusicBrainzGenres', () => {
  it('returns the full genre objects (name, count, id), not just names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            genres: [
              { id: 'e5bba957-8c91-496a-a675-c6d0c6b51c33', name: 'dance', count: 5 },
              { id: '89255676-1f14-4dd8-bbad-fca839d6aff4', name: 'electronic', count: 40 },
            ],
          }),
          { status: 200 }
        )
      )
    );

    const genres = await fetchMusicBrainzGenres('056e4f3e-d505-4dad-8ec1-d04f521cbb56');

    expect(genres).toEqual([
      { id: 'e5bba957-8c91-496a-a675-c6d0c6b51c33', name: 'dance', count: 5 },
      { id: '89255676-1f14-4dd8-bbad-fca839d6aff4', name: 'electronic', count: 40 },
    ]);
    vi.unstubAllGlobals();
  });

  it('returns an empty array when the artist has no MusicBrainz genre tags', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ genres: [] }), { status: 200 })));

    const genres = await fetchMusicBrainzGenres('some-mbid');

    expect(genres).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe('fetchGenreArtistCount', () => {
  it('returns the search response\'s top-level count -- the corpus-wide total, not the page size', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ count: 29075, offset: 0, artists: [{ id: 'x' }] }), { status: 200 }))
    );

    const count = await fetchGenreArtistCount('pop');

    expect(count).toBe(29075);
    vi.unstubAllGlobals();
  });

  it('quotes multi-word genre names in the tag query', async () => {
    let requestedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        requestedUrl = input.toString();
        return new Response(JSON.stringify({ count: 1253 }), { status: 200 });
      })
    );

    await fetchGenreArtistCount('deep house');

    expect(decodeURIComponent(requestedUrl)).toContain('tag:"deep house"');
    vi.unstubAllGlobals();
  });

  it('returns 0 when the response has no count field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));

    const count = await fetchGenreArtistCount('some-obscure-tag');

    expect(count).toBe(0);
    vi.unstubAllGlobals();
  });

  it('throws with the response body on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 503 })));

    await expect(fetchGenreArtistCount('pop')).rejects.toThrow(/503/);
    vi.unstubAllGlobals();
  });
});
