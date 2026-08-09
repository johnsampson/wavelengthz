import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';

export function registerPushRoutes(router: RouterType) {
  router.get('/api/push/vapid-public-key', async (_request: Request, env: Env) => {
    return Response.json({ publicKey: env.VAPID_PUBLIC_KEY });
  });

  router.post('/api/push/subscribe', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const body = await request.json<{ endpoint: string; keys: { p256dh: string; auth: string } }>();
    const { endpoint, keys } = body;

    if (typeof endpoint !== 'string' || !endpoint.trim() || !keys || typeof keys.p256dh !== 'string' || !keys.p256dh.trim() || typeof keys.auth !== 'string' || !keys.auth.trim()) {
      return Response.json({ error: 'invalid_subscription' }, { status: 400 });
    }

    // Beyond non-empty: a malformed endpoint makes `new URL(endpoint)` throw
    // later inside buildVapidAuthHeader (src/lib/webPush.ts) on every future
    // send attempt -- sendPushToUser's catch logs and moves on, but since a
    // thrown request never gets a 404/410 to trigger cleanup, that becomes a
    // permanent poison row. Requiring https also closes off a limited
    // request-forwarding primitive: without this, an authenticated user
    // could point endpoint at an arbitrary URL and have the Worker POST to
    // it (carrying a VAPID Authorization header) on every future
    // notification for their account.
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      return Response.json({ error: 'invalid_subscription' }, { status: 400 });
    }
    if (parsedEndpoint.protocol !== 'https:') {
      return Response.json({ error: 'invalid_subscription' }, { status: 400 });
    }

    await env.DB.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
    ).bind(crypto.randomUUID(), user.id, endpoint, keys.p256dh, keys.auth, Date.now()).run();

    return Response.json({ ok: true });
  });

  router.post('/api/push/unsubscribe', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const body = await request.json<{ endpoint: string }>();
    const { endpoint } = body;

    if (typeof endpoint !== 'string' || !endpoint.trim()) {
      return Response.json({ error: 'invalid_subscription' }, { status: 400 });
    }

    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(endpoint, user.id).run();

    return Response.json({ ok: true });
  });
}
