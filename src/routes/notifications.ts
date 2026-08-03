import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';

export function registerNotificationRoutes(router: RouterType) {
  router.get('/api/notifications', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const rows = await env.DB.prepare(
      `SELECT id, type, related_id, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC`
    ).bind(user.id).all<any>();

    return Response.json({ notifications: rows.results });
  });

  router.post('/api/notifications/:id/read', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const result = await env.DB.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?')
      .bind(Date.now(), request.params.id, user.id)
      .run();

    if (result.meta.changes === 0) return new Response('Not found', { status: 404 });
    return Response.json({ ok: true });
  });
}
