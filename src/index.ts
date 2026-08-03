import { Router } from 'itty-router';
import { registerAuthRoutes } from './routes/auth';
import { registerMeRoutes } from './routes/me';
import { registerAdminRoutes } from './routes/admin';
import { registerOnboardingRoutes } from './routes/onboarding';
import { registerPhotoRoutes } from './routes/photos';
import { registerCatalogRoutes } from './routes/catalog';
import { registerMusicSwipeRoutes } from './routes/musicSwipes';
import { registerPeopleSwipeRoutes } from './routes/peopleSwipes';
import { registerMatchRoutes } from './routes/matches';
import { registerNotificationRoutes } from './routes/notifications';
import { registerSafetyRoutes } from './routes/safety';
import { registerAccountRoutes } from './routes/account';
import { purgeExpiredDeletions } from './lib/accountDeletion';

export const router = Router();

registerAuthRoutes(router);
registerMeRoutes(router);
registerAdminRoutes(router);
registerOnboardingRoutes(router);
registerPhotoRoutes(router);
registerCatalogRoutes(router);
registerMusicSwipeRoutes(router);
registerPeopleSwipeRoutes(router);
registerMatchRoutes(router);
registerNotificationRoutes(router);
registerSafetyRoutes(router);
registerAccountRoutes(router);

router.all('*', () => new Response('Not found', { status: 404 }));

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> =>
    router.fetch(request, env, ctx),
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> => {
    ctx.waitUntil(purgeExpiredDeletions(env, GRACE_PERIOD_MS, Date.now()).then(() => undefined));
  },
};
