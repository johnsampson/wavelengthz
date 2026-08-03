import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';

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

  router.post('/api/report', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { user_id, reason, details } = await request.json<{ user_id: string; reason: string; details?: string }>();
    if (!VALID_REASONS.has(reason)) {
      return Response.json({ error: 'invalid_reason' }, { status: 400 });
    }

    await env.DB.prepare(
      `INSERT INTO reports (id, reporter_id, reported_id, reason, details, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`
    ).bind(crypto.randomUUID(), user.id, user_id, reason, details ?? null, Date.now()).run();

    return Response.json({ ok: true });
  });
}
