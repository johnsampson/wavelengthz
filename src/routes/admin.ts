import type { RouterType } from 'itty-router';
import { seedCatalog } from '../db/seed';

export function registerAdminRoutes(router: RouterType) {
  router.post('/internal/seed', async (request: Request, env: Env) => {
    if (request.headers.get('X-Seed-Secret') !== env.SEED_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    const result = await seedCatalog(env);
    return Response.json(result);
  });
}
