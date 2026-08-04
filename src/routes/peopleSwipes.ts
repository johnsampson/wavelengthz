import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser, type UserRow } from '../lib/session';
import { scoreCandidate, scoreCandidateFromInputs, createMatchIfMutual, type ScoringInputs } from '../lib/matching';
import { getMusicProfiles, getRightSwipedItemIdsFor } from '../lib/profile';
import type { MusicProfile } from '../lib/scoring';
import { bucketedDistanceLabel, haversineKm } from '../lib/scoring';
import { isBlockedEitherDirection } from '../lib/blocks';
import { computeMusicOverlap } from '../lib/musicOverlap';

// Hard cap on the like-priority queue. It previously had no LIMIT at all, so a
// popular account's deck request grew without bound.
const LIKE_PRIORITY_LIMIT = 50;
const POOL_LIMIT = 200;

// Coarse latitude band used to pre-filter the pool in SQL. ~111km per degree
// of latitude everywhere on the globe, so this never excludes anyone who is
// actually within range; the exact haversine check in JS does the real
// exclusion. Longitude is deliberately *not* bounded in SQL: the degrees-per-km
// factor varies with cos(latitude) and the band wraps incorrectly across the
// antimeridian, which would silently drop valid candidates.
const KM_PER_DEGREE_LATITUDE = 111;

/**
 * Batched form of the old per-candidate primary-photo lookup: one query for
 * the whole pool instead of one DB round trip per candidate rendered.
 */
async function primaryPhotoUrls(db: D1Database, userIds: string[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (userIds.length === 0) return urls;

  const rows = await db
    .prepare(
      `SELECT user_id, id FROM user_photos WHERE position = 0 AND user_id IN (${new Array(userIds.length).fill('?').join(', ')})`
    )
    .bind(...userIds)
    .all<{ user_id: string; id: string }>();

  for (const row of rows.results) urls.set(row.user_id, `/photos/${row.id}`);
  return urls;
}

/**
 * Assembles one participant's scoring inputs from the batched lookups. A user
 * absent from either map simply has nothing cached yet, which scores the same
 * as the empty profile/swipe set the single-row loaders return.
 */
function inputsFor(
  userId: string,
  profiles: Map<string, MusicProfile>,
  swipes: Map<string, Set<string>>
): ScoringInputs {
  return {
    profile: profiles.get(userId) ?? { topArtists: [], topGenres: [] },
    rightSwiped: swipes.get(userId) ?? new Set<string>(),
  };
}

// Guards against the "Null Island" bug: `haversineKm` doesn't throw on a null
// lat/lng, JS silently coerces null to 0, so an unonboarded caller would
// otherwise get scored as if they were at (0, 0) with no error.
function hasCompletedOnboarding(user: UserRow): boolean {
  return user.onboarded_at != null && user.lat != null && user.lng != null;
}

export function registerPeopleSwipeRoutes(router: RouterType) {
  router.get('/api/candidates/people', async (request: Request, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    if (!hasCompletedOnboarding(me)) {
      return Response.json({ error: 'onboarding_incomplete' }, { status: 400 });
    }

    const limit = Number(new URL(request.url).searchParams.get('limit') ?? '10');

    // Coarse latitude band, refined by the exact haversine check below. This
    // keeps the pool query from dragging in candidates on the other side of
    // the planet only to have them scored and then discarded.
    const latDelta = me.max_distance_km / KM_PER_DEGREE_LATITUDE;
    const minLat = me.lat! - latDelta;
    const maxLat = me.lat! + latDelta;

    const likePriorityRows = await env.DB.prepare(
      `SELECT u.*, ps.match_score FROM people_swipes ps
       JOIN users u ON u.id = ps.swiper_id
       WHERE ps.target_id = ? AND ps.direction = 'right'
         AND NOT EXISTS (SELECT 1 FROM people_swipes ps2 WHERE ps2.swiper_id = ? AND ps2.target_id = ps.swiper_id)
         AND NOT EXISTS (
           SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = ps.swiper_id) OR (b.blocker_id = ps.swiper_id AND b.blocked_id = ?)
         )
         AND u.deleted_at IS NULL AND u.onboarded_at IS NOT NULL
         AND u.lat IS NOT NULL AND u.lng IS NOT NULL
         AND u.lat BETWEEN ? AND ?
       ORDER BY ps.match_score DESC
       LIMIT ?`
    ).bind(me.id, me.id, me.id, me.id, minLat, maxLat, LIKE_PRIORITY_LIMIT).all<UserRow & { match_score: number }>();

    const likePriorityIds = new Set(likePriorityRows.results.map((r) => r.id));

    const poolRows = await env.DB.prepare(
      `SELECT u.* FROM users u
       WHERE u.id != ? AND u.deleted_at IS NULL AND u.onboarded_at IS NOT NULL
         AND u.lat IS NOT NULL AND u.lng IS NOT NULL
         AND u.lat BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM people_swipes ps WHERE ps.swiper_id = ? AND ps.target_id = u.id)
         AND NOT EXISTS (
           SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?)
         )
       LIMIT ?`
    ).bind(me.id, minLat, maxLat, me.id, me.id, me.id, POOL_LIMIT).all<UserRow>();

    const pool = poolRows.results.filter((u) => !likePriorityIds.has(u.id));

    // max_distance_km is a filter, not just a scoring weight (docs/PLAN.md):
    // someone outside the radius must not appear at all, however good their
    // music overlap is. The SQL band above is intentionally loose, so the
    // authoritative exclusion is this exact haversine check.
    const withinRadius = <T extends UserRow>(candidate: T) =>
      haversineKm(me.lat!, me.lng!, candidate.lat!, candidate.lng!) <= me.max_distance_km;

    const likePriority = likePriorityRows.results.filter(withinRadius);
    const inRangePool = pool.filter(withinRadius);

    // Everything the scorer needs, loaded in a fixed number of queries rather
    // than 4-5 per candidate. `me`'s own profile and right-swipes in
    // particular don't change across the loop, so re-fetching them per
    // candidate was pure waste — and with a full pool it pushed the request
    // past the Workers subrequest limit outright.
    const scoringIds = [me.id, ...inRangePool.map((u) => u.id)];
    const [profiles, rightSwipes] = await Promise.all([
      getMusicProfiles(env.DB, scoringIds),
      getRightSwipedItemIdsFor(env.DB, scoringIds),
    ]);
    const meInputs = inputsFor(me.id, profiles, rightSwipes);

    const scored = inRangePool
      .map((candidate) => ({
        candidate,
        ...scoreCandidateFromInputs(me, meInputs, candidate, inputsFor(candidate.id, profiles, rightSwipes), false),
      }))
      .sort((a, b) => b.score - a.score);

    // Slice before the photo lookup so it only covers what's actually
    // returned. Distance needs no DB access at all — it's haversine over
    // lat/lng we already have — so the like-priority rows never needed the
    // full four-query scoring pass they used to make just to read distanceKm.
    const selected = [
      ...likePriority.map((c) => ({ user: c as UserRow, likedYou: true })),
      ...scored.map(({ candidate }) => ({ user: candidate, likedYou: false })),
    ].slice(0, limit);

    const photoUrls = await primaryPhotoUrls(env.DB, selected.map((s) => s.user.id));

    const candidates = selected.map(({ user, likedYou }) => ({
      id: user.id,
      displayName: user.display_name,
      bio: user.bio,
      distanceLabel: bucketedDistanceLabel(haversineKm(me.lat!, me.lng!, user.lat!, user.lng!)),
      primaryPhotoUrl: photoUrls.get(user.id) ?? null,
      likedYou,
    }));

    return Response.json({ candidates });
  });

  // Viewable for any eligible target -- a not-yet-decided candidate or an
  // active match, not gated to matches only. The point of a music-first
  // dating app is surfacing "why you might match" (photos, bio, shared
  // artists/tracks/genres) before someone decides whether to swipe, not only
  // after a mutual right-swipe.
  router.get('/api/people/:id/profile', async (request: IRequest, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    if (!hasCompletedOnboarding(me)) {
      return Response.json({ error: 'onboarding_incomplete' }, { status: 400 });
    }

    const targetId = request.params.id;
    if (targetId === me.id) {
      return Response.json({ error: 'cannot_view_self' }, { status: 400 });
    }

    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND onboarded_at IS NOT NULL')
      .bind(targetId)
      .first<UserRow>();
    if (!target) return new Response('Not found', { status: 404 });

    if (await isBlockedEitherDirection(env.DB, me.id, targetId)) {
      return new Response('Forbidden', { status: 403 });
    }

    const photoRows = await env.DB.prepare('SELECT id FROM user_photos WHERE user_id = ? ORDER BY position ASC')
      .bind(targetId)
      .all<{ id: string }>();

    const likedYouRow = await env.DB
      .prepare(`SELECT 1 FROM people_swipes WHERE swiper_id = ? AND target_id = ? AND direction = 'right'`)
      .bind(targetId, me.id)
      .first();

    const matchRow = await env.DB
      .prepare(
        `SELECT 1 FROM matches WHERE unmatched_at IS NULL AND
         ((user_a_id = ? AND user_b_id = ?) OR (user_a_id = ? AND user_b_id = ?))`
      )
      .bind(me.id, targetId, targetId, me.id)
      .first();

    const distanceLabel =
      target.lat != null && target.lng != null
        ? bucketedDistanceLabel(haversineKm(me.lat!, me.lng!, target.lat, target.lng))
        : null;

    const overlap = await computeMusicOverlap(env.DB, me.id, targetId);

    return Response.json({
      profile: {
        id: target.id,
        displayName: target.display_name,
        bio: target.bio,
        photoUrls: photoRows.results.map((r) => `/photos/${r.id}`),
        distanceLabel,
        likedYou: !!likedYouRow,
        isMatch: !!matchRow,
      },
      overlap,
    });
  });

  router.post('/api/swipe/people', async (request: Request, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    if (!hasCompletedOnboarding(me)) {
      return Response.json({ error: 'onboarding_incomplete' }, { status: 400 });
    }

    const { target_id, direction } = await request.json<{ target_id: string; direction: 'left' | 'right' }>();

    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
      .bind(target_id)
      .first<UserRow>();
    if (!target) return Response.json({ error: 'unknown target_id' }, { status: 400 });

    if (await isBlockedEitherDirection(env.DB, me.id, target_id)) {
      return Response.json({ error: 'blocked' }, { status: 403 });
    }

    const alreadyLikedMe = await env.DB
      .prepare(`SELECT 1 FROM people_swipes WHERE swiper_id = ? AND target_id = ? AND direction = 'right'`)
      .bind(target_id, me.id)
      .first();

    const { score } = await scoreCandidate(env.DB, me, target, !!alreadyLikedMe);
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(swiper_id, target_id) DO UPDATE SET direction = excluded.direction, match_score = excluded.match_score, updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), me.id, target_id, direction, score, now, now).run();

    let match = null;
    if (direction === 'right') {
      match = await createMatchIfMutual(env.DB, me.id, target_id);
      if (match) {
        const { notifyMatch } = await import('../lib/notifications');
        try {
          await notifyMatch(env.DB, env, match.matchId);
        } catch (err) {
          // Email delivery failures must never turn a successful match into
          // a failed request for the caller -- the match row is already
          // committed. Log and move on.
          console.error('notifyMatch failed', err);
        }
      }
    }

    return Response.json({ ok: true, matched: !!match });
  });

  router.get('/api/swipes/people', async (request: Request, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const direction = url.searchParams.get('direction');
    const directionFilter = direction === 'left' || direction === 'right' ? 'AND ps.direction = ?' : '';

    const rows = await env.DB.prepare(
      `SELECT ps.id, ps.target_id, ps.direction, ps.match_score, ps.created_at, u.display_name as displayName
       FROM people_swipes ps
       JOIN users u ON u.id = ps.target_id
       WHERE ps.swiper_id = ? ${directionFilter}
       ORDER BY ps.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...[me.id, ...(directionFilter ? [direction] : []), limit, offset]).all<any>();

    return Response.json({ swipes: rows.results });
  });

  router.patch('/api/swipes/people/:id', async (request: IRequest, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    const { direction } = await request.json<{ direction: 'left' | 'right' }>();

    const swipe = await env.DB.prepare('SELECT target_id FROM people_swipes WHERE id = ? AND swiper_id = ?')
      .bind(request.params.id, me.id)
      .first<{ target_id: string }>();
    if (!swipe) return new Response('Not found', { status: 404 });

    await env.DB.prepare(
      `UPDATE people_swipes SET direction = ?, updated_at = ? WHERE id = ? AND swiper_id = ?`
    ).bind(direction, Date.now(), request.params.id, me.id).run();

    // Changing a past decision to right can complete a mutual like exactly
    // like a fresh right-swipe through the deck would -- this must create the
    // match too, not just record the direction.
    let match = null;
    if (direction === 'right') {
      match = await createMatchIfMutual(env.DB, me.id, swipe.target_id);
      if (match) {
        const { notifyMatch } = await import('../lib/notifications');
        try {
          await notifyMatch(env.DB, env, match.matchId);
        } catch (err) {
          console.error('notifyMatch failed', err);
        }
      }
    }

    return Response.json({ ok: true, matched: !!match });
  });
}
