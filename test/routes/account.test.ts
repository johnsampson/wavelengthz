import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  // Sessions before users: soft-deleting a user (via DELETE /api/account) leaves
  // its session row in place, and D1 enforces the sessions.user_id FK, so a prior
  // test's leftover session would trip the constraint if `users` were wiped first.
  await env.DB.exec('DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM sessions; DELETE FROM users;');
  await insertTestUser(env.DB, {
    id: 'u1',
    spotifyId: 'sp1',
    accessToken: 'a',
    refreshToken: 'r',
    tokenExpiresAt: 9999999999999,
    createdAt: 1000,
    updatedAt: 1000,
  });
});

describe('DELETE /api/account', () => {
  it('soft-deletes immediately (row still exists, deleted_at set) without waiting for the grace period', async () => {
    const { cookie } = await createSession(env.DB, 'u1');
    const sessionId = cookie.split(';')[0].split('=')[1];
    const res = await worker.fetch(
      new Request('http://localhost/api/account', { method: 'DELETE', headers: { Cookie: `wl_session=${sessionId}` } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT deleted_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.deleted_at).not.toBeNull();
  });

  it('a soft-deleted user can no longer authenticate a session', async () => {
    const { cookie } = await createSession(env.DB, 'u1');
    const sessionId = cookie.split(';')[0].split('=')[1];
    await worker.fetch(new Request('http://localhost/api/account', { method: 'DELETE', headers: { Cookie: `wl_session=${sessionId}` } }), env, {} as ExecutionContext);

    const res = await worker.fetch(new Request('http://localhost/api/me', { headers: { Cookie: `wl_session=${sessionId}` } }), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });
});
