import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { getValidAccessToken } from '../lib/tokens';

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

    const accessToken = await getValidAccessToken(user, env, env.DB);
    return Response.json({ available: true, accessToken });
  });
}
