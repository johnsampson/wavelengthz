import { Router } from 'itty-router';
import { registerAuthRoutes } from './routes/auth';

export const router = Router();

registerAuthRoutes(router);

router.all('*', () => new Response('Not found', { status: 404 }));

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    router.fetch(request, env, ctx),
};
