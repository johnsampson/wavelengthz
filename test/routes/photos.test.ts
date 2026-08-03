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

  it('renumbers the remaining photos so position 0 is never left vacant', async () => {
    // primaryPhotoUrl (people-swipe deck) selects strictly `WHERE position = 0`,
    // and new uploads take position = COUNT(*). Without renumbering, deleting
    // your first photo leaves nothing at position 0 forever -- you go
    // permanently photoless in other users' decks -- and the next upload
    // collides with an existing position.
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u1', 'users/u1/p1.jpg', 0, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p2', 'u1', 'users/u1/p2.jpg', 1, 2000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p3', 'u1', 'users/u1/p3.jpg', 2, 3000)`
    ).run();

    const res = await worker.fetch(
      new Request('http://localhost/api/photos/p1', { method: 'DELETE', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const rows = await env.DB.prepare('SELECT id, position FROM user_photos WHERE user_id = ? ORDER BY position').bind('u1').all<any>();
    expect(rows.results.map((r: any) => [r.id, r.position])).toEqual([
      ['p2', 0],
      ['p3', 1],
    ]);
  });

  it('leaves another user\'s photo positions untouched when renumbering', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES ('u2', 'sp2', 'a', 'r', 9999999999999, 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u1', 'users/u1/p1.jpg', 0, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('q1', 'u2', 'users/u2/q1.jpg', 0, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('q2', 'u2', 'users/u2/q2.jpg', 1, 2000)`
    ).run();

    const cookie = await cookieFor('u1');
    await worker.fetch(
      new Request('http://localhost/api/photos/p1', { method: 'DELETE', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );

    const rows = await env.DB.prepare('SELECT id, position FROM user_photos WHERE user_id = ? ORDER BY position').bind('u2').all<any>();
    expect(rows.results.map((r: any) => [r.id, r.position])).toEqual([
      ['q1', 0],
      ['q2', 1],
    ]);
  });

  it('lets the next upload take a non-colliding position after a delete', async () => {
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u1', 'users/u1/p1.jpg', 0, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p2', 'u1', 'users/u1/p2.jpg', 1, 2000)`
    ).run();

    await worker.fetch(
      new Request('http://localhost/api/photos/p1', { method: 'DELETE', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );

    const uploadRes = await worker.fetch(
      new Request('http://localhost/api/photos', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 1000 }),
      }),
      env,
      {} as ExecutionContext
    );
    const uploaded = await uploadRes.json<any>();

    const rows = await env.DB.prepare('SELECT position FROM user_photos WHERE user_id = ? ORDER BY position').bind('u1').all<any>();
    expect(rows.results.map((r: any) => r.position)).toEqual([0, 1]);
    const newRow = await env.DB.prepare('SELECT position FROM user_photos WHERE id = ?').bind(uploaded.photoId).first<any>();
    expect(newRow.position).toBe(1);
  });
});

describe('GET /photos/:id', () => {
  it('streams the photo bytes with the stored content type when it is an allowed image type', async () => {
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
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new TextEncoder().encode('fake-jpeg-bytes'));
  });

  it('does not echo back a stored content type outside the upload whitelist (stored-XSS guard)', async () => {
    // The presigned PUT URL only binds `host` into the SigV4 signature, so a
    // client that asked for an `image/jpeg` slot can still PUT an HTML payload
    // with `Content-Type: text/html`. Serving that value back verbatim on our
    // own origin is stored XSS with same-origin access to the victim's
    // session, so the stored value is whitelisted on the way out.
    const cookie = await cookieFor('u1');
    await env.PHOTOS.put('users/u1/evil.jpg', new Blob(['<script>alert(1)</script>']), {
      httpMetadata: { contentType: 'text/html' },
    });
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('evil', 'u1', 'users/u1/evil.jpg', 0, 1000)`
    ).run();

    const req = new Request('http://localhost/photos/evil', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('falls back to application/octet-stream when no content type was stored at all', async () => {
    const cookie = await cookieFor('u1');
    await env.PHOTOS.put('users/u1/bare.jpg', new Blob(['bytes']));
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('bare', 'u1', 'users/u1/bare.jpg', 0, 1000)`
    ).run();

    const res = await worker.fetch(
      new Request('http://localhost/photos/bare', { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('returns 404 for an unknown photo id', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/photos/does-not-exist', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(404);
  });
});
