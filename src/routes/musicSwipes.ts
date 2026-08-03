import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';

export function registerMusicSwipeRoutes(router: RouterType) {
  router.get('/api/candidates/music', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const itemType = url.searchParams.get('item_type') ?? 'artist';
    const limit = Number(url.searchParams.get('limit') ?? '10');
    const table = itemType === 'track' ? 'tracks' : 'artists';

    const rows = await env.DB.prepare(
      `SELECT id, name FROM ${table}
       WHERE approved = 1 AND id NOT IN (
         SELECT item_id FROM music_swipes WHERE user_id = ? AND item_type = ?
       )
       ORDER BY created_at ASC
       LIMIT ?`
    ).bind(user.id, itemType, limit).all<{ id: string; name: string }>();

    return Response.json({
      candidates: rows.results.map((r) => ({ itemType, itemId: r.id, name: r.name })),
    });
  });

  router.post('/api/swipe/music', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { item_type, item_id, direction } = await request.json<{
      item_type: 'artist' | 'track';
      item_id: string;
      direction: 'left' | 'right';
    }>();
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET direction = excluded.direction, updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), user.id, item_type, item_id, direction, now, now).run();

    return Response.json({ ok: true });
  });

  router.get('/api/swipes/music', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const offset = Number(url.searchParams.get('offset') ?? '0');

    const rows = await env.DB.prepare(
      `SELECT ms.id, ms.item_type, ms.item_id, ms.direction, ms.created_at,
              COALESCE(a.name, t.name) as name
       FROM music_swipes ms
       LEFT JOIN artists a ON ms.item_type = 'artist' AND a.id = ms.item_id
       LEFT JOIN tracks t ON ms.item_type = 'track' AND t.id = ms.item_id
       WHERE ms.user_id = ?
       ORDER BY ms.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(user.id, limit, offset).all<any>();

    return Response.json({ swipes: rows.results });
  });

  router.patch('/api/swipes/music/:id', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { direction } = await request.json<{ direction: 'left' | 'right' }>();
    const result = await env.DB.prepare(
      `UPDATE music_swipes SET direction = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    ).bind(direction, Date.now(), request.params.id, user.id).run();

    if (result.meta.changes === 0) return new Response('Not found', { status: 404 });
    return Response.json({ ok: true });
  });
}
