import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';

// A user's explicit choice to hide a genre from their music swipe deck
// entirely (src/routes/musicSwipes.ts's blockedGenreFilter), distinct from
// the running pass_count on user_genres that triggers the prompt to block
// in the first place.
export function registerGenreBlockRoutes(router: RouterType) {
  router.get('/api/genres/blocked', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const rows = await env.DB.prepare('SELECT genre FROM user_blocked_genres WHERE user_id = ? ORDER BY genre ASC')
      .bind(user.id)
      .all<{ genre: string }>();

    return Response.json({ genres: rows.results.map((r) => r.genre) });
  });

  router.post('/api/genres/:genre/block', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const genre = decodeURIComponent(request.params.genre);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO user_blocked_genres (id, user_id, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, genre) DO UPDATE SET updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), user.id, genre, now, now).run();

    return Response.json({ ok: true });
  });

  router.post('/api/genres/:genre/unblock', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const genre = decodeURIComponent(request.params.genre);
    await env.DB.prepare('DELETE FROM user_blocked_genres WHERE user_id = ? AND genre = ?').bind(user.id, genre).run();

    return Response.json({ ok: true });
  });
}
