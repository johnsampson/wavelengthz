import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { seedCatalog, SEED_GENRES, SAFE_ARTISTS_PER_RUN } from '../../src/db/seed';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM genres; DELETE FROM tracks; DELETE FROM artists;');
});

describe('seedCatalog', () => {
  it('inserts artists and tracks across the seed genre list, deduped by id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('/v1/search') && url.includes('type=artist')) {
          // every genre search returns the SAME artist id to exercise dedup
          return new Response(
            JSON.stringify({
              artists: {
                items: [
                  { id: 'artist-1', name: 'Shared Artist', genres: ['pop'], images: [{ url: 'http://img/a' }], popularity: 80 },
                ],
              },
            }),
            { status: 200 }
          );
        }
        if (url.includes('/v1/search') && url.includes('type=track')) {
          return new Response(
            JSON.stringify({
              tracks: {
                items: [
                  { id: 'track-1', name: 'Song One', artists: [{ id: 'artist-1', name: 'Shared Artist' }], album: { images: [{ url: 'http://img/t1' }] }, preview_url: 'http://preview/1' },
                  { id: 'track-2', name: 'Song Two', artists: [{ id: 'artist-1', name: 'Shared Artist' }], album: { images: [{ url: 'http://img/t2' }] }, preview_url: null },
                ],
              },
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const result = await seedCatalog(env as any);

    expect(result.artistsInserted).toBe(1); // deduped across all SEED_GENRES
    expect(result.tracksInserted).toBe(2);

    // The catalog's own id is now an app-generated UUID, not the Spotify id
    // directly -- spotify_id is the one to look this row up by.
    const artist = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('artist-1').first<any>();
    expect(artist.source).toBe('seed');
    expect(artist.approved).toBe(1);
    expect(artist.added_by_user_id).toBeNull();

    const trackCount = await env.DB.prepare('SELECT COUNT(*) as c FROM tracks WHERE artist_id = ?').bind(artist.id).first<any>();
    expect(trackCount.c).toBe(2);

    // The catalog-wide genres table should reflect this run too: one artist
    // and two tracks, both tagged 'pop' (the artist's only genre).
    const genreRow = await env.DB.prepare('SELECT * FROM genres WHERE genre = ?').bind('pop').first<any>();
    expect(genreRow.artist_count).toBe(1);
    expect(genreRow.track_count).toBe(2);

    expect(result.failedArtistIds).toEqual([]);

    vi.unstubAllGlobals();
  });

  it('exposes a genre list of at least 10 genres', () => {
    expect(SEED_GENRES.length).toBeGreaterThanOrEqual(10);
  });

  it('skips an artist whose track search fails, without aborting the rest of the run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('/v1/search') && url.includes('type=artist')) {
          // every genre search returns the SAME two artists, to keep this test genre-count-independent
          return new Response(
            JSON.stringify({
              artists: {
                items: [
                  { id: 'artist-ok', name: 'Reliable Artist', genres: ['pop'], images: [{ url: 'http://img/ok' }], popularity: 70 },
                  { id: 'artist-fail', name: 'Flaky Artist', genres: ['pop'], images: [{ url: 'http://img/fail' }], popularity: 60 },
                ],
              },
            }),
            { status: 200 }
          );
        }
        if (url.includes('/v1/search') && url.includes('type=track')) {
          if (url.includes('Flaky')) {
            // simulate a transient upstream failure (e.g. 500/429) for this one artist
            return new Response('server error', { status: 500 });
          }
          return new Response(
            JSON.stringify({
              tracks: {
                items: [
                  { id: 'track-1', name: 'Song One', artists: [{ id: 'artist-ok', name: 'Reliable Artist' }], album: { images: [{ url: 'http://img/t1' }] }, preview_url: 'http://preview/1' },
                  { id: 'track-2', name: 'Song Two', artists: [{ id: 'artist-ok', name: 'Reliable Artist' }], album: { images: [{ url: 'http://img/t2' }] }, preview_url: null },
                ],
              },
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const result = await seedCatalog(env as any);

    // Both artists get inserted (the artist insert happens before the track
    // search that fails for artist-fail); only artist-ok's tracks land.
    expect(result.artistsInserted).toBe(2);
    expect(result.tracksInserted).toBe(2);
    expect(result.failedArtistIds).toEqual(['artist-fail']);

    const failedArtist = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('artist-fail').first<any>();
    expect(failedArtist).not.toBeNull();

    const failedArtistTrackCount = await env.DB.prepare('SELECT COUNT(*) as c FROM tracks WHERE artist_id = ?')
      .bind(failedArtist.id)
      .first<any>();
    expect(failedArtistTrackCount.c).toBe(0);

    vi.unstubAllGlobals();
  });

  it('reports zero new inserts when re-run against a DB that already has everything', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('accounts.spotify.com/api/token')) {
        return new Response(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }), { status: 200 });
      }
      if (url.includes('/v1/search') && url.includes('type=artist')) {
        return new Response(
          JSON.stringify({
            artists: {
              items: [
                { id: 'artist-1', name: 'Shared Artist', genres: ['pop'], images: [{ url: 'http://img/a' }], popularity: 80 },
              ],
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('/v1/search') && url.includes('type=track')) {
        return new Response(
          JSON.stringify({
            tracks: {
              items: [
                { id: 'track-1', name: 'Song One', artists: [{ id: 'artist-1', name: 'Shared Artist' }], album: { images: [{ url: 'http://img/t1' }] }, preview_url: 'http://preview/1' },
                { id: 'track-2', name: 'Song Two', artists: [{ id: 'artist-1', name: 'Shared Artist' }], album: { images: [{ url: 'http://img/t2' }] }, preview_url: null },
              ],
            },
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', mockFetch);

    const firstRun = await seedCatalog(env as any);
    expect(firstRun.artistsInserted).toBe(1);
    expect(firstRun.tracksInserted).toBe(2);

    // Same DB state, no reset — a second run should find everything already
    // present via INSERT OR IGNORE and report zero *new* inserts, not repeat
    // the first run's counts.
    const secondRun = await seedCatalog(env as any);
    expect(secondRun.artistsInserted).toBe(0);
    expect(secondRun.tracksInserted).toBe(0);
    expect(secondRun.failedArtistIds).toEqual([]);

    vi.unstubAllGlobals();
  });

  it('does not re-search tracks for an artist that already exists in the catalog', async () => {
    const trackSearchCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('/v1/search') && url.includes('type=artist')) {
          return new Response(
            JSON.stringify({ artists: { items: [{ id: 'artist-1', name: 'Shared Artist', genres: [], images: [], popularity: 50 }] } }),
            { status: 200 }
          );
        }
        if (url.includes('/v1/search') && url.includes('type=track')) {
          trackSearchCalls.push(url);
          return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    await seedCatalog(env as any);
    expect(trackSearchCalls.length).toBe(1); // first run: genuinely new, searches once

    await seedCatalog(env as any);
    expect(trackSearchCalls.length).toBe(1); // second run: already in DB, never re-searched

    vi.unstubAllGlobals();
  });

  it('paginates within a genre (via offset) to reach a target beyond one search page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('/v1/search') && url.includes('type=artist')) {
          const parsed = new URL(url);
          const genre = parsed.searchParams.get('q') ?? '';
          const offset = Number(parsed.searchParams.get('offset') ?? '0');
          const limit = Number(parsed.searchParams.get('limit') ?? '0');
          // Only "pop" has any results; every other genre is empty (exhausted
          // immediately), forcing the target to be reached by paginating
          // deeper into "pop" rather than spreading across genres. Honors the
          // real requested `limit` (mirroring Spotify's actual per-page cap
          // of 10) rather than a hardcoded page size, so this test stays
          // correct if that constant is ever tuned again.
          if (!genre.includes('pop')) {
            return new Response(JSON.stringify({ artists: { items: [] } }), { status: 200 });
          }
          const items = Array.from({ length: limit }, (_, i) => ({
            id: `pop-${offset}-${i}`,
            name: `Pop Artist ${offset}-${i}`,
            genres: ['pop'],
            images: [],
            popularity: 50,
          }));
          return new Response(JSON.stringify({ artists: { items } }), { status: 200 });
        }
        if (url.includes('/v1/search') && url.includes('type=track')) {
          return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const result = await seedCatalog(env as any, { targetTotal: 60 });

    expect(result.artistsInserted).toBe(60);
    expect(result.reachedTarget).toBe(true);
    expect(result.requestedTotal).toBe(60);

    // Since each page returns only `limit` items, reaching 60 requires more
    // than one page — confirm an artist beyond the first page's worth (i.e.
    // one whose Spotify id encodes a nonzero offset) actually made it into
    // the DB, rather than hardcoding a specific offset value tied to the
    // page size. Checked against spotify_id -- the catalog's own id is now
    // an unrelated generated UUID.
    const artistsFromLaterPages = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM artists WHERE spotify_id NOT LIKE 'pop-0-%'`
    ).first<any>();
    expect(artistsFromLaterPages.c).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it('caps a run at SAFE_ARTISTS_PER_RUN and reports the target was not reached', async () => {
    let counter = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('/v1/search') && url.includes('type=artist')) {
          // Effectively unlimited unique artists across every genre/page.
          const items = Array.from({ length: 50 }, () => {
            counter += 1;
            return { id: `artist-${counter}`, name: `Artist ${counter}`, genres: [], images: [], popularity: 50 };
          });
          return new Response(JSON.stringify({ artists: { items } }), { status: 200 });
        }
        if (url.includes('/v1/search') && url.includes('type=track')) {
          return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const result = await seedCatalog(env as any, { targetTotal: SAFE_ARTISTS_PER_RUN + 300 });

    expect(result.artistsInserted).toBe(SAFE_ARTISTS_PER_RUN);
    expect(result.reachedTarget).toBe(false);
    expect(result.requestedTotal).toBe(SAFE_ARTISTS_PER_RUN + 300);

    vi.unstubAllGlobals();
  });

  it('surfaces per-genre search failures in the result instead of silently returning zero results', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('/v1/search')) {
          // Every genre search is rejected, e.g. a bad/expired credential.
          return new Response('invalid client', { status: 401 });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const result = await seedCatalog(env as any);

    expect(result.artistsInserted).toBe(0);
    expect(Object.keys(result.genreSearchErrors)).toEqual(SEED_GENRES);
    expect(result.genreSearchErrors.pop).toContain('401');
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
