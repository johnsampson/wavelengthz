import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { getValidAccessToken } from '../lib/tokens';
import { fetchCurrentlyPlaying } from '../lib/spotify';

const STREAMING_SCOPE = 'streaming';

export function registerPlayerRoutes(router: RouterType) {
  // Backs public/wavelengthzPlayer.js -- the Spotify Web Playback SDK needs a
  // real OAuth access token available client-side (it makes its own direct
  // calls to Spotify's playback infrastructure), which is a genuine
  // departure from every other Spotify integration in this app, where tokens
  // never leave the Worker. `available: false` is the expected, common-case
  // response, not an error: Free-tier accounts, an account that hasn't
  // re-authorized since the `streaming` scope was added (migration 0008),
  // and someone with no Spotify account state at all all land here the same
  // way, so callers just fall back to the read-only iframe embed uniformly.
  router.get('/api/me/player-token', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const row = await env.DB.prepare(
      `SELECT product_tier, granted_scope FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`
    )
      .bind(user.id)
      .first<{ product_tier: string | null; granted_scope: string | null }>();

    // Checked before ever calling getValidAccessToken (which may spend a
    // real Spotify refresh call) -- neither condition is something a fresh
    // token fixes: Free tier needs an upgrade, and a missing `streaming`
    // scope needs a full re-consent (/login), not a refresh.
    const hasStreamingScope = row?.granted_scope?.split(' ').includes(STREAMING_SCOPE) ?? false;
    if (!row || row.product_tier !== 'premium' || !hasStreamingScope) {
      return Response.json({ available: false });
    }

    // Issue #145 (Round 7) item 2, a recurrence of Round 6 item 10: "paid
    // Spotify members get the basic player" from time to time. Before this,
    // a transient refresh failure here (Spotify momentarily erroring/rate-
    // limiting the token endpoint -- see spotifyFetch's own retry-then-throw
    // in src/lib/spotify.ts) escaped uncaught, turning into a generic 500.
    // The client-side caller (wavelengthzPlayer.js's checkPlayerAvailability)
    // already treats any non-2xx response as `{ available: false }` and,
    // being a page-lifetime-cached singleton, never retries -- so a single
    // bad refresh permanently downgraded an eligible Premium account to the
    // read-only iframe for that whole page load. Caught here instead, same
    // pattern as GET /api/me/now-playing just below: this is a "try again
    // next page load" failure, not a real 500.
    try {
      const accessToken = await getValidAccessToken(user, env, env.DB);
      return Response.json({ available: true, accessToken });
    } catch (error) {
      console.error('player-token: getValidAccessToken failed', error);
      return Response.json({ available: false });
    }
  });

  // Backs the one-tap "send what I'm listening to right now" affordance in
  // message threads. Uses user-read-playback-state, which is ALREADY in
  // spotify.ts's SCOPES and therefore already granted by every existing
  // account -- no re-consent, unlike the playlist-modify-* scopes a real
  // Spotify playlist export would require.
  //
  // `{ playing: null }` is the ordinary case, not an error: nothing playing,
  // a podcast rather than a track, no Spotify connection, or an expired
  // refresh token all land here identically, and the client just doesn't
  // show the button.
  router.get('/api/me/now-playing', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    let track: any | null;
    try {
      const accessToken = await getValidAccessToken(user, env, env.DB);
      track = await fetchCurrentlyPlaying(accessToken, env.RATE_LIMIT_KV);
    } catch (error) {
      // No linked Spotify account, a revoked/expired refresh, or a transient
      // Spotify failure. None of these are worth surfacing as an error on a
      // purely additive convenience -- the caller degrades to searching.
      return Response.json({ playing: null });
    }
    if (!track) return Response.json({ playing: null });

    // Returned in the same shape GET /api/tracks/search hands back, so the
    // client's "share this track" call is identical whichever way the track
    // was chosen. The raw Spotify object rides along under `track` because
    // POST .../messages needs artists[] + album.images to resolve it into the
    // catalog without a follow-up call.
    return Response.json({
      playing: {
        spotifyTrackId: track.id,
        name: track.name,
        artistName: track.artists?.[0]?.name ?? null,
        imageUrl: track.album?.images?.[0]?.url ?? null,
      },
      track: { id: track.id, name: track.name, artists: track.artists, album: track.album, preview_url: track.preview_url ?? null },
    });
  });
}
