import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { encrypt } from '../../src/lib/crypto';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM music_profiles;');
});

describe('GET /api/me', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/me'), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('returns the user and pulls a music profile on first call', async () => {
    const encToken = await encrypt('access-tok', env.TOKEN_ENCRYPTION_KEY);
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES ('u1', 'sp1', ?, ?, ?, 1000, 1000)`
    ).bind(encToken, encToken, Date.now() + 100000).run();
    const { cookie } = await createSession(env.DB, 'u1');
    const sessionId = cookie.split(';')[0].split('=')[1];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('top/artists')) {
          return new Response(JSON.stringify({ items: [{ id: 'a1', name: 'Artist One', genres: ['pop'] }] }), { status: 200 });
        }
        if (url.includes('top/tracks')) {
          return new Response(JSON.stringify({ items: [{ id: 't1', name: 'Track One' }] }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const req = new Request('http://localhost/api/me', { headers: { Cookie: `wl_session=${sessionId}` } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.user.id).toBe('u1');
    expect(body.musicProfile.top_artists).toContain('a1');

    const row = await env.DB.prepare('SELECT * FROM music_profiles WHERE user_id = ?').bind('u1').first<any>();
    expect(row).toBeTruthy();

    vi.unstubAllGlobals();
  });
});
