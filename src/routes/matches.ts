import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { notifyMessage } from '../lib/notifications';
import { computeMusicOverlap } from '../lib/musicOverlap';

// A soft-deleted account must disappear from matches and messaging
// immediately (docs/PLAN.md §9), not linger until the 7-day grace period
// expires and the hard purge runs. `getSessionUser` already excludes the
// *caller* if they're deleted; these joins cover the counterpart.
async function loadActiveMatchForParticipant(db: D1Database, matchId: string, userId: string) {
  return db
    .prepare(
      `SELECT m.* FROM matches m
       JOIN users ua ON ua.id = m.user_a_id
       JOIN users ub ON ub.id = m.user_b_id
       WHERE m.id = ? AND m.unmatched_at IS NULL AND (m.user_a_id = ? OR m.user_b_id = ?)
         AND ua.deleted_at IS NULL AND ub.deleted_at IS NULL`
    )
    .bind(matchId, userId, userId)
    .first<{ id: string; user_a_id: string; user_b_id: string; created_at: number }>();
}

export function registerMatchRoutes(router: RouterType) {
  router.get('/api/matches', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const rows = await env.DB.prepare(
      `SELECT m.id, m.user_a_id, m.user_b_id, m.created_at,
              ua.display_name as user_a_display_name, ub.display_name as user_b_display_name
       FROM matches m
       JOIN users ua ON ua.id = m.user_a_id
       JOIN users ub ON ub.id = m.user_b_id
       WHERE m.unmatched_at IS NULL AND (m.user_a_id = ? OR m.user_b_id = ?)
         AND ua.deleted_at IS NULL AND ub.deleted_at IS NULL
       ORDER BY m.created_at DESC`
    ).bind(user.id, user.id).all<any>();

    const matches = rows.results.map((m) => ({
      id: m.id,
      otherUserId: m.user_a_id === user.id ? m.user_b_id : m.user_a_id,
      otherDisplayName: m.user_a_id === user.id ? m.user_b_display_name : m.user_a_display_name,
      createdAt: m.created_at,
    }));

    return Response.json({ matches });
  });

  router.get('/api/matches/:id', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Forbidden', { status: 403 });

    const otherUserId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id;
    const otherUser = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?')
      .bind(otherUserId)
      .first<{ display_name: string | null }>();

    const overlap = await computeMusicOverlap(env.DB, user.id, otherUserId);

    return Response.json({
      match: {
        id: match.id,
        otherUserId,
        otherDisplayName: otherUser?.display_name ?? null,
        createdAt: match.created_at,
      },
      overlap,
    });
  });

  router.post('/api/matches/:id/unmatch', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Not found', { status: 404 });

    await env.DB.prepare('UPDATE matches SET unmatched_at = ?, unmatched_by = ? WHERE id = ?')
      .bind(Date.now(), user.id, match.id)
      .run();

    return Response.json({ ok: true });
  });

  router.get('/api/matches/:id/messages', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Forbidden', { status: 403 });

    const rows = await env.DB.prepare(
      `SELECT id, sender_id, body, read_at, created_at FROM messages WHERE match_id = ? ORDER BY created_at ASC`
    ).bind(match.id).all<any>();

    return Response.json({ messages: rows.results });
  });

  router.post('/api/matches/:id/messages', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Forbidden', { status: 403 });

    const { body } = await request.json<{ body: string }>();
    const messageId = crypto.randomUUID();
    const now = Date.now();
    const recipientId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id;

    await env.DB.prepare(
      `INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(messageId, match.id, user.id, body, now).run();

    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES (?, ?, 'message', ?, ?)`
    ).bind(crypto.randomUUID(), recipientId, messageId, now).run();

    try {
      await notifyMessage(env.DB, env, messageId, recipientId);
    } catch (err) {
      // Same reasoning as notifyMatch: the message is already committed, so
      // an email-provider failure must not surface as a failed send to the
      // caller.
      console.error('notifyMessage failed', err);
    }

    return Response.json({ ok: true, messageId });
  });
}
