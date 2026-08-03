import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { notifyMessage } from '../lib/notifications';

async function loadActiveMatchForParticipant(db: D1Database, matchId: string, userId: string) {
  return db
    .prepare(`SELECT * FROM matches WHERE id = ? AND unmatched_at IS NULL AND (user_a_id = ? OR user_b_id = ?)`)
    .bind(matchId, userId, userId)
    .first<{ id: string; user_a_id: string; user_b_id: string }>();
}

export function registerMatchRoutes(router: RouterType) {
  router.get('/api/matches', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const rows = await env.DB.prepare(
      `SELECT id, user_a_id, user_b_id, created_at FROM matches
       WHERE unmatched_at IS NULL AND (user_a_id = ? OR user_b_id = ?)
       ORDER BY created_at DESC`
    ).bind(user.id, user.id).all<any>();

    const matches = rows.results.map((m) => ({
      id: m.id,
      otherUserId: m.user_a_id === user.id ? m.user_b_id : m.user_a_id,
      createdAt: m.created_at,
    }));

    return Response.json({ matches });
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

    await notifyMessage(env.DB, env, messageId, recipientId);

    return Response.json({ ok: true, messageId });
  });
}
