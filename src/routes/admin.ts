import type { IRequest, RouterType } from 'itty-router';
import { seedCatalog } from '../db/seed';
import { hardDeleteUser } from '../lib/accountDeletion';
import { constantTimeEqual } from '../lib/crypto';
import { enrichArtistGenresFromMusicBrainz, runHourlyGenreEnrichment } from '../lib/genreEnrichment';
import { fetchGenreDensities } from '../lib/genreDensity';
import { distinctActiveUserCount } from '../lib/analytics';

export function registerAdminRoutes(router: RouterType) {
  router.post('/internal/seed', async (request: Request, env: Env) => {
    if (!constantTimeEqual(request.headers.get('X-Seed-Secret') ?? '', env.SEED_SECRET)) {
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

  // Deliberately slow: MusicBrainz's rate limit means this run takes
  // roughly 2+ seconds per artist (see genreEnrichment.ts). ?count= lets a
  // smaller/larger batch be requested per call; repeated calls make
  // incremental progress since it always picks up genre_enriched_at IS NULL
  // rows first.
  router.post('/internal/enrich-genres', async (request: Request, env: Env) => {
    if (!constantTimeEqual(request.headers.get('X-Seed-Secret') ?? '', env.SEED_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }

    const countParam = new URL(request.url).searchParams.get('count');
    const limit = countParam ? Number(countParam) : undefined;
    if (countParam !== null && (!Number.isFinite(limit) || limit! <= 0)) {
      return Response.json({ error: 'invalid_count' }, { status: 400 });
    }

    const result = await enrichArtistGenresFromMusicBrainz(env.DB, { limit });
    return Response.json(result);
  });

  // Runs the exact same function the hourly cron calls (event.cron ===
  // '0 * * * *' in src/index.ts) -- the KV lock, the 55-minute deadline,
  // all of it -- rather than the smaller fixed-count run above. Useful for
  // running a full sweep on demand, or for testing the lock/deadline
  // behavior for real without waiting for the clock. Because this can run
  // for up to 55 minutes, expect the HTTP response itself to take that
  // long too -- there's no separate "kick off and return immediately"
  // mode here.
  router.post('/internal/enrich-genres/hourly', async (request: Request, env: Env) => {
    if (!constantTimeEqual(request.headers.get('X-Seed-Secret') ?? '', env.SEED_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }

    const result = await runHourlyGenreEnrichment(env.DB, env.RATE_LIMIT_KV);
    return Response.json(result);
  });

  // Manual, count-limited genre-density fetch -- mirrors /internal/enrich-genres's
  // shape (small batch, no lock), separate from the deadline-and-lock-governed
  // hourly path above. Genres are far fewer than artists, so a full run here
  // finishes quickly even without a deadline.
  router.post('/internal/enrich-genre-density', async (request: Request, env: Env) => {
    if (!constantTimeEqual(request.headers.get('X-Seed-Secret') ?? '', env.SEED_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }

    const countParam = new URL(request.url).searchParams.get('count');
    const limit = countParam ? Number(countParam) : undefined;
    if (countParam !== null && (!Number.isFinite(limit) || limit! <= 0)) {
      return Response.json({ error: 'invalid_count' }, { status: 400 });
    }

    const result = await fetchGenreDensities(env.DB, { limit });
    return Response.json(result);
  });

  // Dev/testing convenience: fully wipe a user and everything referencing
  // them (not the 7-day-grace-period soft delete from DELETE /api/account),
  // so the same Spotify account can be re-onboarded from scratch. Looked up
  // by either our internal id or the Spotify id, since after a login you
  // may only know the latter.
  router.post('/internal/users/:id/delete', async (request: IRequest, env: Env) => {
    if (!constantTimeEqual(request.headers.get('X-Seed-Secret') ?? '', env.SEED_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }

    const idParam = request.params.id;
    const user = await env.DB.prepare(
      `SELECT u.id FROM users u
       LEFT JOIN auth_identities ai ON ai.user_id = u.id AND ai.provider = 'spotify'
       WHERE u.id = ? OR ai.provider_id = ?`
    )
      .bind(idParam, idParam)
      .first<{ id: string }>();
    if (!user) return new Response('Not found', { status: 404 });

    await hardDeleteUser(env, user.id);
    return Response.json({ ok: true });
  });

  // Issue #161 (part of the 250K-users strategy discussion): the actual
  // provable number to hand to Spotify's own Extended Quota Mode review if
  // that application ever happens -- distinct identified users with at
  // least one analytics_events row in the trailing `?days=` window
  // (default 30, matching Spotify's own "max 30 days old" requirement for
  // the analytics export they ask applicants to upload), plus the
  // anonymous-event count as a separate, honest reach signal alongside it.
  router.get('/internal/analytics/mau', async (request: Request, env: Env) => {
    if (!constantTimeEqual(request.headers.get('X-Seed-Secret') ?? '', env.SEED_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }

    const daysParam = new URL(request.url).searchParams.get('days');
    const days = daysParam ? Number(daysParam) : 30;
    if (!Number.isFinite(days) || days <= 0) {
      return Response.json({ error: 'invalid_days' }, { status: 400 });
    }

    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = await distinctActiveUserCount(env.DB, sinceMs);
    return Response.json({ days, sinceMs, ...result });
  });
}
