import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';

export function registerAccountRoutes(router: RouterType) {
  router.delete('/api/account', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    await env.DB.prepare('UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .bind(Date.now(), Date.now(), user.id)
      .run();

    return Response.json({ ok: true });
  });
}
