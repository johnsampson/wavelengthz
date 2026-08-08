import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { maybeGhostUser } from '../lib/reports';

const VALID_REASONS = new Set(['inappropriate_photos', 'harassment', 'fake_profile', 'spam', 'underage', 'other']);

export function registerSafetyRoutes(router: RouterType) {
  router.post('/api/block', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { user_id } = await request.json<{ user_id: string }>();
    const now = Date.now();

    await env.DB.prepare(
      `INSERT OR IGNORE INTO blocks (id, blocker_id, blocked_id, created_at) VALUES (?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), user.id, user_id, now).run();

    const [a, b] = [user.id, user_id].sort();
    await env.DB.prepare(
      `UPDATE matches SET unmatched_at = ?, unmatched_by = ? WHERE user_a_id = ? AND user_b_id = ? AND unmatched_at IS NULL`
    ).bind(now, user.id, a, b).run();

    return Response.json({ ok: true });
  });

  router.get('/api/blocks', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const rows = await env.DB.prepare(
      `SELECT b.blocked_id, u.display_name, b.created_at FROM blocks b
       JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ?
       ORDER BY b.created_at DESC`
    ).bind(user.id).all<{ blocked_id: string; display_name: string | null; created_at: number }>();

    return Response.json({
      blocks: rows.results.map((r) => ({ userId: r.blocked_id, displayName: r.display_name, blockedAt: r.created_at })),
    });
  });

  // "Unblock" deliberately doesn't restore the original swipe or clear it back
  // to unswiped -- it sets it to passed (left), same as History's own
  // "Change" toggle. You blocked this person for a reason; unblocking just
  // stops actively enforcing that, it isn't consent to match again.
  router.post('/api/blocks/:id/unblock', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const blockedId = request.params.id;
    const result = await env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
      .bind(user.id, blockedId)
      .run();
    if (result.meta.changes === 0) return new Response('Not found', { status: 404 });

    await env.DB.prepare(
      `UPDATE people_swipes SET direction = 'left', updated_at = ? WHERE swiper_id = ? AND target_id = ?`
    ).bind(Date.now(), user.id, blockedId).run();

    return Response.json({ ok: true });
  });

  router.post('/api/report', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { user_id, reason, details } = await request.json<{ user_id: string; reason: string; details?: string }>();
    if (!VALID_REASONS.has(reason)) {
      return Response.json({ error: 'invalid_reason' }, { status: 400 });
    }

    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO reports (id, reporter_id, reported_id, reason, details, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`
    ).bind(crypto.randomUUID(), user.id, user_id, reason, details ?? null, now).run();

    // Ghost removal: once 3+ distinct people have reported the same person,
    // they silently stop appearing to or interacting with anyone else --
    // enforced in peopleSwipes.ts/matching.ts/matches.ts, not here.
    await maybeGhostUser(env.DB, user_id, now);

    return Response.json({ ok: true });
  });
}
