import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PHOTOS = 10;

export function registerPhotoRoutes(router: RouterType) {
  router.get('/api/photos', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const rows = await env.DB.prepare('SELECT id, position FROM user_photos WHERE user_id = ? ORDER BY position ASC')
      .bind(user.id)
      .all<{ id: string; position: number }>();

    return Response.json({
      photos: rows.results.map((r) => ({ photoId: r.id, url: `/photos/${r.id}`, position: r.position })),
    });
  });

  router.post('/api/photos', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    // Uploaded directly to the Worker (not a client-side presigned R2 PUT):
    // a presigned URL points straight at R2's real S3-compatible endpoint,
    // which in local dev is an entirely different storage backend from the
    // `env.PHOTOS` binding this route (and GET /photos/:id) reads through --
    // an upload could "succeed" and still be invisible to the app that just
    // wrote it. Routing the bytes through the Worker keeps writes and reads
    // on the same binding in every environment, and removes the CORS
    // dependency on the R2 bucket entirely.
    const contentType = request.headers.get('Content-Type') ?? '';
    if (!ALLOWED_TYPES.has(contentType)) {
      return Response.json({ error: 'unsupported_type' }, { status: 400 });
    }

    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BYTES) {
      return Response.json({ error: 'file_too_large' }, { status: 400 });
    }

    const countRow = await env.DB.prepare('SELECT COUNT(*) as c FROM user_photos WHERE user_id = ?')
      .bind(user.id)
      .first<{ c: number }>();
    const position = countRow?.c ?? 0;
    if (position >= MAX_PHOTOS) {
      return Response.json({ error: 'too_many_photos' }, { status: 400 });
    }

    const photoId = crypto.randomUUID();
    const ext = contentType.split('/')[1];
    const r2Key = `users/${user.id}/${photoId}.${ext}`;

    await env.PHOTOS.put(r2Key, body, { httpMetadata: { contentType } });

    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(photoId, user.id, r2Key, position, now, now).run();

    return Response.json({ photoId, url: `/photos/${photoId}` });
  });

  router.delete('/api/photos/:id', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const photo = await env.DB.prepare('SELECT * FROM user_photos WHERE id = ? AND user_id = ?')
      .bind(request.params.id, user.id)
      .first<{ r2_key: string }>();
    if (!photo) return new Response('Not found', { status: 404 });

    await env.PHOTOS.delete(photo.r2_key);
    await env.DB.prepare('DELETE FROM user_photos WHERE id = ?').bind(request.params.id).run();

    // Close the gap the delete just opened. `primaryPhotoUrl` (people-swipe
    // deck) matches strictly on `position = 0` and new uploads take
    // `position = COUNT(*)`, so leaving a hole would make the user
    // permanently photoless to everyone else the moment they delete their
    // first photo -- and would let the next upload collide with an existing
    // position.
    const remaining = await env.DB.prepare(
      'SELECT id FROM user_photos WHERE user_id = ? ORDER BY position ASC, created_at ASC'
    )
      .bind(user.id)
      .all<{ id: string }>();

    const renumberedAt = Date.now();
    const renumber = env.DB.prepare('UPDATE user_photos SET position = ?, updated_at = ? WHERE id = ?');
    const statements = remaining.results.map((row, index) => renumber.bind(index, renumberedAt, row.id));
    if (statements.length > 0) await env.DB.batch(statements);

    return Response.json({ ok: true });
  });

  router.get('/photos/:id', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const photo = await env.DB.prepare('SELECT r2_key FROM user_photos WHERE id = ?')
      .bind(request.params.id)
      .first<{ r2_key: string }>();
    if (!photo) return new Response('Not found', { status: 404 });

    const object = await env.PHOTOS.get(photo.r2_key);
    if (!object) return new Response('Not found', { status: 404 });

    // Defense in depth: POST /api/photos already validates Content-Type
    // before storing, so this shouldn't ever see anything outside the
    // whitelist -- but never trust stored data blindly on the way back out.
    // Echoing an arbitrary stored type back would risk stored XSS on our own
    // origin with same-origin access to the victim's session; `nosniff` stops
    // the browser from content-sniffing its way past the fallback too.
    const storedType = object.httpMetadata?.contentType;
    const contentType = storedType && ALLOWED_TYPES.has(storedType) ? storedType : 'application/octet-stream';

    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
