import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { getMatchNotificationDelayMs } from '../lib/notifications';

export function registerNotificationRoutes(router: RouterType) {
  router.get('/api/notifications', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    // Both notification types need to resolve to a matchId so the client can
    // link straight to /match?id= regardless of type: for 'match', related_id
    // already is one; for 'message', related_id is a messages.id and the
    // match it belongs to has to be looked up via that message.
    //
    // 'match' rows younger than getMatchNotificationDelayMs are excluded
    // entirely (bell badge included, since it's driven by this same query) --
    // see src/lib/notifications.ts for why.
    //
    // A notification whose underlying match has since been unmatched (either
    // directly, for a 'match' notification, or via the message it points to,
    // for a 'message' notification) is excluded too -- otherwise it lingers
    // in the feed forever pointing at a matchId that /match?id= can no longer
    // load, surfacing as "Could not load this match" when clicked. The
    // NOT EXISTS is vacuously true (so nothing is excluded) when the
    // resolved id doesn't correspond to a real match row at all.
    const rows = await env.DB.prepare(
      `SELECT n.id, n.type, n.related_id, n.read_at, n.created_at,
              CASE WHEN n.type = 'match' THEN n.related_id ELSE msg.match_id END as match_id
       FROM notifications n
       LEFT JOIN messages msg ON n.type = 'message' AND msg.id = n.related_id
       WHERE n.user_id = ? AND (n.type != 'match' OR n.created_at <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM matches m
           WHERE m.id = CASE WHEN n.type = 'match' THEN n.related_id ELSE msg.match_id END
             AND m.unmatched_at IS NOT NULL
         )
       ORDER BY n.created_at DESC`
    ).bind(user.id, Date.now() - getMatchNotificationDelayMs(env)).all<any>();

    return Response.json({
      notifications: rows.results.map((r) => ({
        id: r.id,
        type: r.type,
        relatedId: r.related_id,
        matchId: r.match_id,
        readAt: r.read_at,
        createdAt: r.created_at,
      })),
    });
  });

  router.post('/api/notifications/:id/read', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const readAt = Date.now();
    const result = await env.DB.prepare('UPDATE notifications SET read_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(readAt, readAt, request.params.id, user.id)
      .run();

    if (result.meta.changes === 0) return new Response('Not found', { status: 404 });
    return Response.json({ ok: true });
  });
}
