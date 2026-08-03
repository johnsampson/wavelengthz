import { Router } from 'itty-router';
import { registerAuthRoutes } from './routes/auth';
import { registerMeRoutes } from './routes/me';
import { registerAdminRoutes } from './routes/admin';
import { registerOnboardingRoutes } from './routes/onboarding';
import { registerPhotoRoutes } from './routes/photos';
import { registerCatalogRoutes } from './routes/catalog';
import { registerMusicSwipeRoutes } from './routes/musicSwipes';
import { registerPeopleSwipeRoutes } from './routes/peopleSwipes';

export const router = Router();

registerAuthRoutes(router);
registerMeRoutes(router);
registerAdminRoutes(router);
registerOnboardingRoutes(router);
registerPhotoRoutes(router);
registerCatalogRoutes(router);
registerMusicSwipeRoutes(router);
registerPeopleSwipeRoutes(router);

router.all('*', () => new Response('Not found', { status: 404 }));

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> =>
    router.fetch(request, env, ctx),
};
