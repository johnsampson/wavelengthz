import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { createPresignedUploadUrl } from '../lib/r2';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024;

export function registerPhotoRoutes(router: RouterType) {
  router.post('/api/photos', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { contentType, sizeBytes } = await request.json<{ contentType: string; sizeBytes: number }>();
    if (!ALLOWED_TYPES.has(contentType)) {
      return Response.json({ error: 'unsupported_type' }, { status: 400 });
    }
    if (sizeBytes > MAX_BYTES) {
      return Response.json({ error: 'file_too_large' }, { status: 400 });
    }

    const countRow = await env.DB.prepare('SELECT COUNT(*) as c FROM user_photos WHERE user_id = ?')
      .bind(user.id)
      .first<{ c: number }>();
    const position = countRow?.c ?? 0;

    const photoId = crypto.randomUUID();
    const ext = contentType.split('/')[1];
    const r2Key = `users/${user.id}/${photoId}.${ext}`;

    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(photoId, user.id, r2Key, position, Date.now()).run();

    const uploadUrl = await createPresignedUploadUrl(env, r2Key, contentType, 300);

    return Response.json({ photoId, uploadUrl, r2Key });
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

    return new Response(object.body, {
      headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream' },
    });
  });
}
