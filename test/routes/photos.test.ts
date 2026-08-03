import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM user_photos; DELETE FROM users;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

describe('POST /api/photos', () => {
  it('rejects an unsupported content type', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/photos', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/gif', sizeBytes: 1000 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it('rejects a file over the size limit', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/photos', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 20 * 1024 * 1024 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it('returns a signed upload URL and creates a photo row', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/photos', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 1000 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.uploadUrl).toContain('X-Amz-Signature');
    const row = await env.DB.prepare('SELECT * FROM user_photos WHERE id = ?').bind(body.photoId).first<any>();
    expect(row.user_id).toBe('u1');
    expect(row.position).toBe(0);
  });
});

describe('DELETE /api/photos/:id', () => {
  it('removes the photo row', async () => {
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u1', 'users/u1/p1.jpg', 0, 1000)`
    ).run();
    const req = new Request('http://localhost/api/photos/p1', { method: 'DELETE', headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM user_photos WHERE id = ?').bind('p1').first();
    expect(row).toBeNull();
  });
});

describe('GET /photos/:id', () => {
  it('streams the photo bytes with the stored content type', async () => {
    const cookie = await cookieFor('u1');
    await env.PHOTOS.put('users/u1/p1.jpg', new Blob(['fake-jpeg-bytes']), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u1', 'users/u1/p1.jpg', 0, 1000)`
    ).run();

    const req = new Request('http://localhost/photos/p1', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new TextEncoder().encode('fake-jpeg-bytes'));
  });

  it('returns 404 for an unknown photo id', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/photos/does-not-exist', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(404);
  });
});
