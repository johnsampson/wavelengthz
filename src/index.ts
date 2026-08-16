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
import { registerPlayerRoutes } from './routes/player';
import { registerPushRoutes } from './routes/push';
import { registerGenreBlockRoutes } from './routes/genreBlocks';
import { registerPhoneRoutes } from './routes/phone';
import { purgeExpiredDeletions } from './lib/accountDeletion';
import { refreshCatalogFromProfiles } from './db/catalogRefresh';
import { discoverArtistsByGenre } from './lib/catalogDiscovery';
import { sendDelayedMatchNotificationEmails } from './lib/notifications';
import { runHourlyGenreEnrichment, processGenreEnrichmentQueueBatch, type GenreEnrichmentQueueMessage } from './lib/genreEnrichment';
import { processArtistTrackBackfillBatch, type ArtistTrackBackfillMessage } from './lib/artistTrackBackfill';
import { checkRateLimit } from './lib/rateLimit';
import { reportError } from './lib/sentry';
import { constantTimeEqual } from './lib/crypto';
import { SpotifyRateLimitError } from './lib/spotify';

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
registerPlayerRoutes(router);
registerPushRoutes(router);
registerGenreBlockRoutes(router);
registerPhoneRoutes(router);

// Falls back to the ASSETS binding (static HTML/JS/CSS under public/) for
// anything that isn't an API route -- required once [assets].run_worker_first
// routes every request through this Worker first, rather than letting
// Cloudflare serve static assets before the Worker ever runs. `env.ASSETS`
// is only undefined in the test harness (no such binding is configured
// there), where the plain 404 this used to always return is exactly what
// existing tests already expect.
router.all('*', (request: Request, env: Env) => (env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 })));

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
// Each call that gets past the VOIP/invalid-number check sends a real,
// billed SMS via Twilio Verify -- a much tighter bucket than the general
// limit is warranted purely on cost/abuse grounds, independent of anything
// Twilio's own Verify service rate-limits on its side.
const PHONE_VERIFY_LIMIT = { limit: 5, windowSeconds: 60 };
// public/messages.html and public/group.html each poll their own
// GET .../messages endpoint every 3s while the tab is visible (20 req/min,
// per open tab) -- legitimate, expected traffic, not abuse. Left on the
// shared general bucket, a couple of open chat tabs alone permanently
// saturate GENERAL_LIMIT (120/min) for that IP: every *other* unrelated
// action -- loading an artist, swiping, anything -- gets starved out by
// background polling that never stops refilling the bucket, so the 429s
// never actually clear no matter how long you wait. Its own bucket, sized
// for a handful of concurrently-open polling tabs (60/20 = 3), keeps that
// traffic from crowding out everything else in the app, the same reasoning
// SWIPE_LIMIT/CALLBACK_LIMIT/PHONE_VERIFY_LIMIT already get their own
// buckets for.
const POLL_LIMIT = { limit: 60, windowSeconds: 60 };

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
    // connect-src was 'self' only until the Wavelengthz Player
    // (public/wavelengthzPlayer.js): every other Spotify integration in this
    // app is server-side (the Worker calls Spotify, never the browser), but
    // the Web Playback SDK is a genuine exception -- it's a client-side SDK
    // that opens its own realtime connection to Spotify's Connect
    // infrastructure and calls the Web API directly from the page. The exact
    // set of hosts it needs isn't fully pinned down in Spotify's own docs
    // (regionally-sharded edge hosts under spotify.com are involved), so
    // this allows Spotify's own domains broadly rather than guessing at
    // specific undocumented subdomains -- verify against a real Premium
    // session before shipping; a wrong/missing host here fails silently as a
    // CSP violation, not a visible error, which src/routes/player.ts's
    // `available: false` fallback exists to survive either way.
    //
    // script-src additionally allows sdk.scdn.co, which serves the SDK's own
    // script; frame-src additionally allows sdk.scdn.co because the SDK
    // embeds its own hidden iframe there for DRM-protected audio decoding
    // (Spotify's EME requirement) -- invisible and fully controlled via the
    // SDK's JS API, not a user-facing Spotify UI the way open.spotify.com's
    // embed (below) is.
    //
    // frame-src's open.spotify.com entry is the pre-existing fallback track
    // embed (public/artist.html et al) -- Spotify stopped returning
    // preview_url for tracks, so that fallback plays via
    // https://open.spotify.com/embed/track/{id} instead of an <audio> tag.
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://sdk.scdn.co; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://img.wavelengthz.com https://*.scdn.co data:; connect-src 'self' https://*.spotify.com wss://*.spotify.com https://*.scdn.co; frame-src https://open.spotify.com https://sdk.scdn.co; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Paths exempt from the password gate below -- iOS/Android's "Add to Home
// Screen" fetches manifest.json and the apple-touch-icon/manifest icon
// files as unauthenticated, OS-level background requests that never carry
// Safari's cached Basic Auth credentials (those live in the browser tab,
// not the installer process). Gating these meant every icon fetch 401'd
// during pre-launch, silently failing closed into iOS's default letter-
// avatar icon instead of ever showing the real logo -- confirmed as the
// root cause of the app's home-screen icon showing a plain "W". None of
// these paths expose anything sensitive (just a logo and static app
// metadata), so exempting them doesn't weaken the gate's actual purpose of
// keeping app content/API access closed pre-launch.
// '/login/spotify' and '/callback' are a deliberate, known hole in the
// gate, not an oversight: iOS's installed PWA (standalone display mode)
// handles HTTP Basic Auth unreliably across a cross-origin redirect chain
// (wavelengthz.com -> accounts.spotify.com -> back to wavelengthz.com/
// callback) -- there's often no UI to even show the native auth prompt in
// standalone mode, so Spotify login failed 100% of the time from the
// installed app while working fine from a regular Safari/Chrome tab
// (where cached Basic Auth credentials are attached automatically). The
// properly-closed fix is replacing this whole gate with a cookie-based
// login page (cookies, unlike Basic Auth, are shared between Safari and
// the installed PWA) -- deferred as a bigger follow-up. Until then, anyone
// who finds these two exact URLs can complete a real Spotify OAuth login
// and create a live account without ever seeing the site password prompt.
// Explicitly accepted as a pre-launch trade-off; revisit before real launch.
const SITE_BASIC_AUTH_EXEMPT_PATHS = new Set([
  '/manifest.json',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/login/spotify',
  '/callback',
]);

// Pre-launch site-wide password gate -- a no-op unless both
// SITE_BASIC_AUTH_USER/PASSWORD are set (see src/env.d.ts). Checked first,
// before rate limiting/routing/anything else, and ahead of ASSETS too (once
// [assets].run_worker_first is on, every request -- API and static alike --
// reaches this handler), so nothing about the app is reachable without it,
// except the paths exempted above.
function checkSiteBasicAuth(request: Request, env: Env): Response | null {
  if (!env.SITE_BASIC_AUTH_USER || !env.SITE_BASIC_AUTH_PASSWORD) return null;
  if (SITE_BASIC_AUTH_EXEMPT_PATHS.has(new URL(request.url).pathname)) return null;

  const expected = 'Basic ' + btoa(`${env.SITE_BASIC_AUTH_USER}:${env.SITE_BASIC_AUTH_PASSWORD}`);
  const provided = request.headers.get('Authorization') ?? '';
  if (constantTimeEqual(provided, expected)) return null;

  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Wavelengthz (pre-launch)"' },
  });
}

// KV writes are limited to roughly one per second per key, and every request
// sharing a rate-limit bucket (a busy user, or many users behind one shared
// NAT/corporate egress IP) writes to that same key -- so sustained traffic
// above that rate throws inside checkRateLimit under real production load.
// Rate limiting is best-effort defense, not core functionality: this reports
// the failure (the exact visibility the surrounding try/catch was already
// built to give a KV outage) but fails open rather than letting an ordinary
// request 500 just because its rate-limit check couldn't complete.
async function rateLimitAllows(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number,
  env: Env,
  ctx: ExecutionContext,
  path: string
): Promise<boolean> {
  try {
    return await checkRateLimit(kv, key, limit, windowSeconds);
  } catch (error) {
    console.error(`Rate limit check failed for ${path}:`, error);
    if (typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(reportError(env, error, { path }));
    } else {
      await reportError(env, error, { path });
    }
    return true;
  }
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const authResponse = checkSiteBasicAuth(request, env);
    if (authResponse) return authResponse;

    const url = new URL(request.url);

    try {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

      if (url.pathname.startsWith('/api/swipe/')) {
        const swipeAllowed = await rateLimitAllows(env.RATE_LIMIT_KV, `swipe:${ip}`, SWIPE_LIMIT.limit, SWIPE_LIMIT.windowSeconds, env, ctx, url.pathname);
        if (!swipeAllowed) return withSecurityHeaders(Response.json({ error: 'rate_limited' }, { status: 429 }));
      }

      if (url.pathname === '/callback') {
        const callbackAllowed = await rateLimitAllows(env.RATE_LIMIT_KV, `callback:${ip}`, CALLBACK_LIMIT.limit, CALLBACK_LIMIT.windowSeconds, env, ctx, url.pathname);
        if (!callbackAllowed) return withSecurityHeaders(Response.json({ error: 'rate_limited' }, { status: 429 }));
      }

      if (url.pathname === '/api/phone/verify/start') {
        const phoneVerifyAllowed = await checkRateLimit(env.RATE_LIMIT_KV, `phone-verify:${ip}`, PHONE_VERIFY_LIMIT.limit, PHONE_VERIFY_LIMIT.windowSeconds);
        if (!phoneVerifyAllowed) return withSecurityHeaders(Response.json({ error: 'rate_limited' }, { status: 429 }));
      }

      // GET .../messages under either -- see POLL_LIMIT's own comment.
      // Deliberately its own bucket instead of ALSO falling through to the
      // general check below (unlike swipe/phone-verify, which count against
      // both that bucket and general): the whole point is to stop this
      // traffic from consuming the same budget as everything else, so it
      // can't be allowed to double-count against general too.
      const isPollPath = request.method === 'GET' && /^\/api\/(matches|groups)\/[^/]+\/messages$/.test(url.pathname);

      if (isPollPath) {
        const pollAllowed = await rateLimitAllows(env.RATE_LIMIT_KV, `poll:${ip}`, POLL_LIMIT.limit, POLL_LIMIT.windowSeconds, env, ctx, url.pathname);
        if (!pollAllowed) return withSecurityHeaders(Response.json({ error: 'rate_limited' }, { status: 429 }));
      } else if (url.pathname.startsWith('/api/')) {
        const generallyAllowed = await rateLimitAllows(env.RATE_LIMIT_KV, `general:${ip}`, GENERAL_LIMIT.limit, GENERAL_LIMIT.windowSeconds, env, ctx, url.pathname);
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

      // Spotify's own rate limit, not this app's (see spotifyFetch's own
      // comment in src/lib/spotify.ts) -- surfaced as its own distinct
      // status/body rather than folded into the generic 500 below, so the
      // frontend (public/artist.html) can tell "try again in a moment,
      // Spotify is busy" apart from every other failure mode, instead of
      // both landing on the exact same opaque message.
      if (error instanceof SpotifyRateLimitError) {
        return withSecurityHeaders(Response.json({ error: 'spotify_rate_limited' }, { status: 503 }));
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

    if (event.cron === '0 4 * * sun') {
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
    } else if (event.cron === '0 * * * *') {
      ctx.waitUntil(
        runHourlyGenreEnrichment(env.DB, env.RATE_LIMIT_KV)
          .then(() => undefined)
          .catch(report('scheduled:runHourlyGenreEnrichment'))
      );
    } else if (event.cron === '30 */6 * * *') {
      // runIndex rotates which slice of SEED_GENRES this run advances (see
      // nextDiscoveryTargets). Derived from the wall clock rather than stored
      // state: at one run every 6 hours this increments by exactly 1 each
      // time, so successive runs walk successive genre slices, and a missed
      // or replayed run just skips/repeats a slice rather than corrupting
      // anything -- the per-genre offsets that actually matter live in KV.
      const runIndex = Math.floor(event.scheduledTime / (6 * 60 * 60 * 1000));
      ctx.waitUntil(
        discoverArtistsByGenre(env, runIndex)
          .then(() => undefined)
          .catch(report('scheduled:discoverArtistsByGenre'))
      );
    } else {
      ctx.waitUntil(
        purgeExpiredDeletions(env, GRACE_PERIOD_MS, Date.now())
          .then(() => undefined)
          .catch(report('scheduled:purgeExpiredDeletions'))
      );
    }
  },
  // A single `queue` export handles every queue this Worker consumes from --
  // Cloudflare doesn't support one export per queue, so batch.queue (the
  // real queue name, `-test` suffixed under env.test) is the only way to
  // tell which one a given batch came from. TS can't narrow
  // MessageBatch<A | B> to MessageBatch<A> from that check on its own, hence
  // the explicit cast in each branch -- batch.queue is what actually
  // guarantees the shape at runtime.
  queue: async (batch: MessageBatch<GenreEnrichmentQueueMessage | ArtistTrackBackfillMessage>, env: Env): Promise<void> => {
    if (batch.queue.startsWith('artist-track-backfill')) {
      await processArtistTrackBackfillBatch(batch as MessageBatch<ArtistTrackBackfillMessage>, env);
    } else {
      await processGenreEnrichmentQueueBatch(batch as MessageBatch<GenreEnrichmentQueueMessage>, env.DB);
    }
  },
};
