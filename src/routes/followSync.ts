import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { getFollowSyncStatus, runFollowSync, setFollowSyncEnabled } from '../lib/followSync';

export function registerFollowSyncRoutes(router: RouterType) {
  // Entirely D1-backed -- no Spotify call -- so the settings page never
  // spends quota just to render a toggle.
  router.get('/api/me/follow-sync', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    return Response.json(await getFollowSyncStatus(env.DB, user.id));
  });

  // Off only. Enabling requires FOLLOW_SYNC_SCOPE, which only a full OAuth
  // round trip (/login/spotify?intent=follow) can grant -- same reasoning as
  // the playlist equivalent.
  //
  // Disabling never unfollows anyone. Those follows are the user's now, and
  // silently undoing something visible on their public profile because they
  // flipped an app toggle would be worse than the original write.
  router.post('/api/me/follow-sync/disable', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    await setFollowSyncEnabled(env.DB, user.id, false, Date.now());
    return Response.json(await getFollowSyncStatus(env.DB, user.id));
  });

  router.post('/api/me/follow-sync/run', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const result = await runFollowSync(env, user);
    return Response.json({ ...result, status: await getFollowSyncStatus(env.DB, user.id) });
  });
}
