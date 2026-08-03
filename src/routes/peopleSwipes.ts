import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser, type UserRow } from '../lib/session';
import { scoreCandidate, createMatchIfMutual } from '../lib/matching';
import { bucketedDistanceLabel } from '../lib/scoring';

async function primaryPhotoUrl(db: D1Database, userId: string): Promise<string | null> {
  const photo = await db.prepare('SELECT id FROM user_photos WHERE user_id = ? AND position = 0')
    .bind(userId)
    .first<{ id: string }>();
  return photo ? `/photos/${photo.id}` : null;
}

export function registerPeopleSwipeRoutes(router: RouterType) {
  router.get('/api/candidates/people', async (request: Request, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    const limit = Number(new URL(request.url).searchParams.get('limit') ?? '10');

    const likePriorityRows = await env.DB.prepare(
      `SELECT u.*, ps.match_score FROM people_swipes ps
       JOIN users u ON u.id = ps.swiper_id
       WHERE ps.target_id = ? AND ps.direction = 'right'
         AND NOT EXISTS (SELECT 1 FROM people_swipes ps2 WHERE ps2.swiper_id = ? AND ps2.target_id = ps.swiper_id)
         AND NOT EXISTS (
           SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = ps.swiper_id) OR (b.blocker_id = ps.swiper_id AND b.blocked_id = ?)
         )
         AND u.deleted_at IS NULL
       ORDER BY ps.match_score DESC`
    ).bind(me.id, me.id, me.id, me.id).all<UserRow & { match_score: number }>();

    const likePriorityIds = new Set(likePriorityRows.results.map((r) => r.id));

    const poolRows = await env.DB.prepare(
      `SELECT u.* FROM users u
       WHERE u.id != ? AND u.deleted_at IS NULL AND u.onboarded_at IS NOT NULL
         AND u.lat IS NOT NULL AND u.lng IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM people_swipes ps WHERE ps.swiper_id = ? AND ps.target_id = u.id)
         AND NOT EXISTS (
           SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?)
         )
       LIMIT 200`
    ).bind(me.id, me.id, me.id, me.id).all<UserRow>();

    const pool = poolRows.results.filter((u) => !likePriorityIds.has(u.id));

    const scored = await Promise.all(
      pool.map(async (candidate) => {
        const { score, distanceKm } = await scoreCandidate(env.DB, me, candidate, false);
        return { candidate, score, distanceKm };
      })
    );
    scored.sort((a, b) => b.score - a.score);

    const likePriorityFormatted = await Promise.all(
      likePriorityRows.results.map(async (c) => ({
        id: c.id,
        displayName: c.display_name,
        bio: c.bio,
        distanceLabel: bucketedDistanceLabel((await scoreCandidate(env.DB, me, c, true)).distanceKm),
        primaryPhotoUrl: await primaryPhotoUrl(env.DB, c.id),
        likedYou: true,
      }))
    );

    const normalFormatted = await Promise.all(
      scored.map(async ({ candidate, distanceKm }) => ({
        id: candidate.id,
        displayName: candidate.display_name,
        bio: candidate.bio,
        distanceLabel: bucketedDistanceLabel(distanceKm),
        primaryPhotoUrl: await primaryPhotoUrl(env.DB, candidate.id),
        likedYou: false,
      }))
    );

    const candidates = [...likePriorityFormatted, ...normalFormatted].slice(0, limit);

    return Response.json({ candidates });
  });

  router.post('/api/swipe/people', async (request: Request, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    const { target_id, direction } = await request.json<{ target_id: string; direction: 'left' | 'right' }>();

    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(target_id).first<UserRow>();
    if (!target) return Response.json({ error: 'unknown target_id' }, { status: 400 });

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
    }

    return Response.json({ ok: true, matched: !!match });
  });

  router.get('/api/swipes/people', async (request: Request, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const offset = Number(url.searchParams.get('offset') ?? '0');

    const rows = await env.DB.prepare(
      `SELECT ps.id, ps.target_id, ps.direction, ps.match_score, ps.created_at, u.display_name as displayName
       FROM people_swipes ps
       JOIN users u ON u.id = ps.target_id
       WHERE ps.swiper_id = ?
       ORDER BY ps.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(me.id, limit, offset).all<any>();

    return Response.json({ swipes: rows.results });
  });

  router.patch('/api/swipes/people/:id', async (request: IRequest, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    const { direction } = await request.json<{ direction: 'left' | 'right' }>();
    const result = await env.DB.prepare(
      `UPDATE people_swipes SET direction = ?, updated_at = ? WHERE id = ? AND swiper_id = ?`
    ).bind(direction, Date.now(), request.params.id, me.id).run();

    if (result.meta.changes === 0) return new Response('Not found', { status: 404 });
    return Response.json({ ok: true });
  });
}
