import type { IRequest, RouterType } from 'itty-router';
import { seedCatalog } from '../db/seed';
import { hardDeleteUser } from '../lib/accountDeletion';

export function registerAdminRoutes(router: RouterType) {
  router.post('/internal/seed', async (request: Request, env: Env) => {
    if (request.headers.get('X-Seed-Secret') !== env.SEED_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    const countParam = new URL(request.url).searchParams.get('count');
    const targetTotal = countParam ? Number(countParam) : undefined;
    if (countParam !== null && (!Number.isFinite(targetTotal) || targetTotal! <= 0)) {
      return Response.json({ error: 'invalid_count' }, { status: 400 });
    }

    const result = await seedCatalog(env, targetTotal ? { targetTotal } : undefined);
    return Response.json(result);
  });

  // Dev/testing convenience: fully wipe a user and everything referencing
  // them (not the 7-day-grace-period soft delete from DELETE /api/account),
  // so the same Spotify account can be re-onboarded from scratch. Looked up
  // by either our internal id or the Spotify id, since after a login you
  // may only know the latter.
  router.post('/internal/users/:id/delete', async (request: IRequest, env: Env) => {
    if (request.headers.get('X-Seed-Secret') !== env.SEED_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    const idParam = request.params.id;
    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ? OR spotify_id = ?')
      .bind(idParam, idParam)
      .first<{ id: string }>();
    if (!user) return new Response('Not found', { status: 404 });

    await hardDeleteUser(env, user.id);
    return Response.json({ ok: true });
  });
}
