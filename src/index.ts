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
import { registerGroupRoutes } from './routes/groups';
import { purgeExpiredDeletions } from './lib/accountDeletion';
import { refreshCatalogFromProfiles } from './db/catalogRefresh';
import { sendDelayedMatchNotificationEmails } from './lib/notifications';
import { checkRateLimit } from './lib/rateLimit';
import { reportError } from './lib/sentry';

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
registerGroupRoutes(router);

router.all('*', () => new Response('Not found', { status: 404 }));

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

const GENERAL_LIMIT = { limit: 120, windowSeconds: 60 };
const SWIPE_LIMIT = { limit: 30, windowSeconds: 60 };
// /callback is where Spotify OAuth actually creates accounts, and the plan
// requires rate-limiting on account creation -- but it was excluded entirely,
// because the middleware only matched `/api/`. It gets its own bucket, tighter
// than the general limit: a legitimate user hits this once per login, so 20/min
// still leaves generous headroom for a shared NAT / carrier-grade IP while
// cutting the ceiling on scripted mass account creation by 6x.
const CALLBACK_LIMIT = { limit: 20, windowSeconds: 60 };

// Static HTML/JS/CSS under public/ is served directly by the Assets binding
// and never reaches this fetch() handler at all (no run_worker_first), so
// these headers only cover Worker-generated responses (API routes,
// /login, /photos/:id, etc). The static pages get the *same* headers via
// public/_headers instead -- Cloudflare's documented mechanism for exactly
// this split (see the Workers Static Assets docs: "_headers" is applied to
// static-asset responses and explicitly does NOT cover Worker responses,
// which is why this second copy exists here rather than relying on one or
// the other alone).
function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    // 'unsafe-eval' is required by Alpine.js's default (non-CSP) build: every
    // x-data/x-show/@click/etc. directive expression is evaluated via
    // `new Function(...)` under the hood, which CSP treats identically to
    // `eval()`. Without it, EVERY page using Alpine breaks outright ("Alpine
    // Expression Error: ... violates ... 'unsafe-eval'"), not just one --
    // this was caught live on the match page but affects the whole app.
    // Rewriting every page's directives against Alpine's CSP-safe build is a
    // real option later, but out of scope for this pass.
    'Content-Security-Policy',
    // connect-src is 'self' only: no app code calls fetch() against the CDN/
    // fonts/image hosts directly (they're only ever loaded via native
    // <script src>/<link>/<img> tags, governed by script-src/style-src/
    // img-src respectively). public/sw.js previously re-issued ALL requests
    // -- including cross-origin ones -- via its own fetch(), which forced
    // connect-src to list every such host too (a moving target: jsdelivr,
    // then googleapis/gstatic, then scdn.co for artist images). Fixed at the
    // root in the service worker instead (cross-origin requests are no
    // longer intercepted at all), so connect-src can stay minimal.
    //
    // frame-src allows Spotify's own track embed (public/artist.html) --
    // Spotify stopped returning preview_url for tracks, so playback now goes
    // through https://open.spotify.com/embed/track/{id} instead of an
    // <audio> tag.
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://*.scdn.co data:; connect-src 'self'; frame-src https://open.spotify.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);

    // The rate-limit checks live *inside* this try. They talk to KV, so a KV
    // outage throws -- and outside the try that surfaced as a bare unhandled
    // 500 that Sentry never saw, which is exactly the failure you most need
    // visibility into.
    try {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

      if (url.pathname.startsWith('/api/swipe/')) {
        const swipeAllowed = await checkRateLimit(env.RATE_LIMIT_KV, `swipe:${ip}`, SWIPE_LIMIT.limit, SWIPE_LIMIT.windowSeconds);
        if (!swipeAllowed) return withSecurityHeaders(Response.json({ error: 'rate_limited' }, { status: 429 }));
      }

      if (url.pathname === '/callback') {
        const callbackAllowed = await checkRateLimit(env.RATE_LIMIT_KV, `callback:${ip}`, CALLBACK_LIMIT.limit, CALLBACK_LIMIT.windowSeconds);
        if (!callbackAllowed) return withSecurityHeaders(Response.json({ error: 'rate_limited' }, { status: 429 }));
      }

      if (url.pathname.startsWith('/api/')) {
        const generallyAllowed = await checkRateLimit(env.RATE_LIMIT_KV, `general:${ip}`, GENERAL_LIMIT.limit, GENERAL_LIMIT.windowSeconds);
        if (!generallyAllowed) return withSecurityHeaders(Response.json({ error: 'rate_limited' }, { status: 429 }));
      }

      return withSecurityHeaders(await router.fetch(request, env, ctx));
    } catch (error) {
      // Always log locally first -- reportError only reaches Sentry, which
      // in local dev is typically an unmonitored placeholder DSN. Without
      // this, a route throwing is completely invisible in `wrangler dev`'s
      // own terminal, even though the response correctly still comes back
      // as a generic 500.
      console.error(`Unhandled error on ${url.pathname}:`, error);

      // Prefer fire-and-forget via ctx.waitUntil (always present on real
      // Workers runtimes) so a slow or unreachable Sentry never delays the
      // client's 500 response. Only fall back to awaiting directly when
      // waitUntil isn't available (e.g. tests that pass a minimal fake
      // ExecutionContext) — reportError is documented to never throw, so
      // awaiting it there is still safe, just not fire-and-forget.
      if (typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(reportError(env, error, { path: url.pathname }));
      } else {
        await reportError(env, error, { path: url.pathname });
      }
      return withSecurityHeaders(new Response('Internal Server Error', { status: 500 }));
    }
  },
  scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> => {
    // waitUntil swallows rejections, so anything that escapes the job itself
    // would vanish without a trace. purgeExpiredDeletions already isolates and
    // reports per-user failures; this catch covers the whole-job failures
    // (e.g. the initial SELECT) that it can't.
    const report = (path: string) => (error: unknown) => reportError(env, error, { path });

    if (event.cron === '0 4 * * 0') {
      ctx.waitUntil(
        refreshCatalogFromProfiles(env)
          .then(() => undefined)
          .catch(report('scheduled:refreshCatalogFromProfiles'))
      );
    } else if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(
        sendDelayedMatchNotificationEmails(env, Date.now())
          .then(() => undefined)
          .catch(report('scheduled:sendDelayedMatchNotificationEmails'))
      );
    } else {
      ctx.waitUntil(
        purgeExpiredDeletions(env, GRACE_PERIOD_MS, Date.now())
          .then(() => undefined)
          .catch(report('scheduled:purgeExpiredDeletions'))
      );
    }
  },
};
