import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';

export function registerPushRoutes(router: RouterType) {
  router.get('/api/push/vapid-public-key', async (_request: Request, env: Env) => {
    return Response.json({ publicKey: env.VAPID_PUBLIC_KEY });
  });

  router.post('/api/push/subscribe', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { endpoint, keys } = await request.json<{ endpoint: string; keys: { p256dh: string; auth: string } }>();

    await env.DB.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
    ).bind(crypto.randomUUID(), user.id, endpoint, keys.p256dh, keys.auth, Date.now()).run();

    return Response.json({ ok: true });
  });

  router.post('/api/push/unsubscribe', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { endpoint } = await request.json<{ endpoint: string }>();
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(endpoint, user.id).run();

    return Response.json({ ok: true });
  });
}
