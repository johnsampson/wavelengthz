import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { getSyncStatus, runPlaylistSync, setSyncEnabled } from '../lib/playlistSync';

export function registerPlaylistSyncRoutes(router: RouterType) {
  // Backs the playlist-sync section of public/settings/connections.js.
  // Entirely D1-backed -- no Spotify call -- so loading the settings page
  // never spends quota just to render a toggle.
  router.get('/api/me/playlist-sync', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    return Response.json(await getSyncStatus(env.DB, user.id));
  });

  // Turning sync OFF only. There is deliberately no "on" here: enabling
  // requires PLAYLIST_SYNC_SCOPE, which can only be granted by a full OAuth
  // round trip (/login/spotify?intent=sync), and that flow's callback is what
  // flips the flag. A POST that set enabled = 1 without a matching grant
  // would just produce a toggle that claims to be on while every sync run
  // skips with 'scope_missing'.
  //
  // Disabling never revokes the Spotify grant and never deletes anything
  // already in the playlist -- the playlist is the user's, and songs already
  // there are theirs to keep. It only stops future writes.
  router.post('/api/me/playlist-sync/disable', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    await setSyncEnabled(env.DB, user.id, false, Date.now());
    return Response.json(await getSyncStatus(env.DB, user.id));
  });

  // "Sync now" -- the same operation the cron runs, exposed so a first-time
  // backfill is something the user explicitly triggers and sees the result
  // of, rather than a silent bulk write into their account the instant they
  // flip a toggle.
  router.post('/api/me/playlist-sync/run', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const result = await runPlaylistSync(env, user);
    return Response.json({ ...result, status: await getSyncStatus(env.DB, user.id) });
  });
}
