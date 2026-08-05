import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  // Child rows before parent `users` rows -- D1 enforces FK constraints here.
  await env.DB.exec('DELETE FROM notifications; DELETE FROM messages; DELETE FROM matches; DELETE FROM sessions; DELETE FROM users;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u2', 'sp2', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n1', 'u1', 'match', 'm1', 1000)`).run();
  await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n2', 'u2', 'match', 'm2', 1000)`).run();
});

describe('GET /api/notifications', () => {
  it('returns only the current user notifications', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/notifications', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.notifications.length).toBe(1);
    expect(body.notifications[0].id).toBe('n1');
  });

  it('resolves matchId directly from related_id for a match notification', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/notifications', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.notifications[0].matchId).toBe('m1');
  });

  it('excludes a match notification created less than 15 minutes ago', async () => {
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n-recent', 'u1', 'match', 'm-recent', ?)`
    ).bind(Date.now() - 60 * 1000).run(); // 1 minute ago

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/notifications', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.notifications.find((n: any) => n.id === 'n-recent')).toBeUndefined();
  });

  it('includes a match notification once 15 minutes have passed', async () => {
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n-old-enough', 'u1', 'match', 'm-old-enough', ?)`
    ).bind(Date.now() - 16 * 60 * 1000).run(); // 16 minutes ago

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/notifications', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.notifications.find((n: any) => n.id === 'n-old-enough')).toBeDefined();
  });

  it('never delays a message notification, however recent', async () => {
    await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m4', 'u1', 'u2', 500)`).run();
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg2', 'm4', 'u2', 'hey', ?)`).bind(Date.now()).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n-msg-recent', 'u1', 'message', 'msg2', ?)`
    ).bind(Date.now()).run();

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/notifications', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.notifications.find((n: any) => n.id === 'n-msg-recent')).toBeDefined();
  });

  it('excludes a match notification whose match has since been unmatched', async () => {
    await env.DB.prepare(
      `INSERT INTO matches (id, user_a_id, user_b_id, unmatched_at, unmatched_by, created_at) VALUES ('m-gone', 'u1', 'u2', ?, 'u2', ?)`
    ).bind(Date.now(), Date.now() - 16 * 60 * 1000).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n-unmatched', 'u1', 'match', 'm-gone', ?)`
    ).bind(Date.now() - 16 * 60 * 1000).run();

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/notifications', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.notifications.find((n: any) => n.id === 'n-unmatched')).toBeUndefined();
  });

  it('excludes a message notification whose match has since been unmatched', async () => {
    await env.DB.prepare(
      `INSERT INTO matches (id, user_a_id, user_b_id, unmatched_at, unmatched_by, created_at) VALUES ('m-gone2', 'u1', 'u2', ?, 'u2', 500)`
    ).bind(Date.now()).run();
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg-gone', 'm-gone2', 'u2', 'hey', 900)`).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n-msg-unmatched', 'u1', 'message', 'msg-gone', ?)`
    ).bind(Date.now()).run();

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/notifications', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.notifications.find((n: any) => n.id === 'n-msg-unmatched')).toBeUndefined();
  });

  it('resolves matchId via the message\'s match for a message notification', async () => {
    await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m3', 'u1', 'u2', 500)`).run();
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm3', 'u2', 'hey', 900)`).run();
    await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`).run();

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/notifications', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    const messageNotif = body.notifications.find((n: any) => n.id === 'n3');
    expect(messageNotif.matchId).toBe('m3');
  });
});

describe('POST /api/notifications/:id/read', () => {
  it('marks the notification read when owned by the caller', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/notifications/n1/read', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT read_at FROM notifications WHERE id = ?').bind('n1').first<any>();
    expect(row.read_at).not.toBeNull();
  });

  it('returns 404 for a notification owned by someone else', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/notifications/n2/read', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(404);
  });
});
