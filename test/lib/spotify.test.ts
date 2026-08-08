import { describe, it, expect, vi } from 'vitest';
import { buildAuthUrl, fetchSpotifyProfile, searchTracksByArtistName } from '../../src/lib/spotify';

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

describe('searchTracksByArtistName', () => {
  it('excludes tracks whose artists do not actually include the requested artist id', async () => {
    // Spotify's name-based `artist:"X"` search is a fuzzy text match, not an
    // exact filter -- it can return tracks by an unrelated artist that
    // happens to share a name. Each returned track carries its real
    // `artists` list (with Spotify ids), which is the only reliable way to
    // confirm a result actually belongs to the artist we asked about.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            tracks: {
              items: [
                { id: 't1', name: 'Right Song', artists: [{ id: 'artist-1', name: 'Real Artist' }] },
                { id: 't2', name: 'Wrong Song', artists: [{ id: 'artist-2', name: 'Same Name, Different Act' }] },
              ],
            },
          }),
          { status: 200 }
        )
      )
    );

    const tracks = await searchTracksByArtistName('token', 'artist-1', 'Real Artist', 10);

    expect(tracks.map((t: any) => t.id)).toEqual(['t1']);
    vi.unstubAllGlobals();
  });
});
