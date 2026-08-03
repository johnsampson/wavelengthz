import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function makeUser(id: string, email: string | null) {
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, email, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`, email).run();
}

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  // Child rows before parent `users` rows -- D1 enforces FK constraints here.
  // messages -> matches, users; notifications -> users; matches -> users; sessions -> users.
  await env.DB.exec('DELETE FROM messages; DELETE FROM notifications; DELETE FROM sessions; DELETE FROM matches; DELETE FROM users;');
  await makeUser('u1', 'u1@example.com');
  await makeUser('u2', 'u2@example.com');
  await makeUser('u3', null);
  await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m1', 'u1', 'u2', 1000)`).run();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

describe('GET /api/matches', () => {
  it('lists active matches with the other participant', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/matches', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.matches[0].otherUserId).toBe('u2');
  });

  it('excludes a match after it is unmatched', async () => {
    const cookie = await cookieFor('u1');
    await worker.fetch(
      new Request('http://localhost/api/matches/m1/unmatch', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    const res = await worker.fetch(new Request('http://localhost/api/matches', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.matches.length).toBe(0);
  });

  it('rejects an unmatch attempt from a non-participant and leaves the match active', async () => {
    const cookie = await cookieFor('u3');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/unmatch', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(404);

    const match = await env.DB.prepare('SELECT unmatched_at FROM matches WHERE id = ?').bind('m1').first<any>();
    expect(match.unmatched_at).toBeNull();
  });
});

describe('messages', () => {
  it('rejects a non-participant', async () => {
    const cookie = await cookieFor('u3');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
  });

  it('sends a message, notifies, and emails the recipient', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hey there' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const messages = await env.DB.prepare('SELECT * FROM messages WHERE match_id = ?').bind('m1').all<any>();
    expect(messages.results.length).toBe(1);

    const notification = await env.DB.prepare("SELECT * FROM notifications WHERE type = 'message' AND user_id = 'u2'").first<any>();
    expect(notification).toBeTruthy();
    expect(notification.email_sent_at).not.toBeNull();
  });

  it('blocks messaging after unmatch', async () => {
    const cookie = await cookieFor('u1');
    await worker.fetch(new Request('http://localhost/api/matches/m1/unmatch', { method: 'POST', headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
  });
});
