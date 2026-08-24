import type { RouterType } from 'itty-router';
import { getClientCredentialsToken, fetchArtistById, SpotifyRateLimitError } from '../lib/spotify';

// A default well-known artist so this works with zero query params -- The
// Beatles' id, stable and unlikely to ever be deleted/renamed on Spotify's
// side, chosen purely for human-recognizability when eyeballing the
// response (any real artist id proves the same thing).
const DEFAULT_TEST_ARTIST_ID = '3WrFJ7ztbogyGnTHbHJFl2';

// Public, unauthenticated "is our Spotify integration actually working"
// check -- exists for two purposes: (1) a quick manual sanity check when
// investigating a "the site feels blocked again" report, to tell apart a
// real regression in this app's own code from Spotify's own Development
// Mode rate limiting (see spotify.ts's own comment on
// SPOTIFY_RETRY_ABANDON_THRESHOLD_SECONDS -- a real, previously-confirmed
// production issue, not a bug in this codebase), and (2) a link that can be
// handed to Spotify's own app-review team when applying for Extended Quota
// Mode, since that application asks for a public URL where they can
// exercise the integration's primary Web API call (Get Artist) themselves.
//
// Deliberately NOT behind getSessionUser -- Spotify's reviewers (and anyone
// else checking connectivity) have no Wavelengthz account. Client-
// credentials only (app-level auth, not a user's own token), and the one
// downstream call is a plain read of public Spotify catalog data, so there
// is nothing user-specific or sensitive to protect here. Also listed in
// src/index.ts's SITE_BASIC_AUTH_EXEMPT_PATHS so the pre-launch password
// gate doesn't block it either.
//
// Deliberately bypasses this codebase's usual DB-first rule (CLAUDE.md) --
// the whole point is to prove the LIVE Spotify connection works, not to
// answer from the catalog cache, same reasoning as the two live-search
// endpoints CLAUDE.md itself calls out as the deliberate exception.
export function registerSpotifyHealthRoutes(router: RouterType) {
  router.get('/api/spotify/connection-test', async (request: Request, env: Env) => {
    const artistId = new URL(request.url).searchParams.get('artistId') || DEFAULT_TEST_ARTIST_ID;

    let token: string;
    try {
      token = await getClientCredentialsToken(env);
    } catch (error) {
      if (error instanceof SpotifyRateLimitError) throw error; // let index.ts's global 503 handling take it
      return Response.json(
        { ok: false, step: 'client_credentials_token', error: error instanceof Error ? error.message : String(error) },
        { status: 502 }
      );
    }

    let artist: any;
    try {
      artist = await fetchArtistById(token, artistId);
    } catch (error) {
      if (error instanceof SpotifyRateLimitError) throw error; // ditto
      return Response.json(
        { ok: false, step: 'get_artist', error: error instanceof Error ? error.message : String(error) },
        { status: 502 }
      );
    }

    return Response.json({
      ok: true,
      artist: {
        id: artist.id,
        name: artist.name,
        genres: artist.genres ?? [],
        popularity: artist.popularity ?? null,
        imageUrl: artist.images?.[0]?.url ?? null,
        spotifyUrl: artist.external_urls?.spotify ?? null,
      },
    });
  });
}
