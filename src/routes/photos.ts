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

    const renumber = env.DB.prepare('UPDATE user_photos SET position = ? WHERE id = ?');
    const statements = remaining.results.map((row, index) => renumber.bind(index, row.id));
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

    // The presigned upload URL only binds `host` into the SigV4 signature
    // (src/lib/r2.ts), so the stored `Content-Type` is attacker-controlled
    // regardless of what was declared to POST /api/photos: a client can claim
    // an `image/jpeg` slot and then PUT an HTML/JS payload as `text/html`.
    // Echoing that back would be stored XSS on our own origin with
    // same-origin access to the victim's session. Whitelist the stored value
    // against the same set the upload endpoint accepts, and send `nosniff` so
    // the browser can't content-sniff its way past the fallback either.
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
