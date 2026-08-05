import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { notifyMatch, notifyMessage, sendDelayedMatchNotificationEmails, MATCH_NOTIFICATION_DELAY_MS } from '../../src/lib/notifications';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  // Child rows before parent `users` rows -- D1 enforces FK constraints here.
  // messages -> matches, users; notifications -> users; matches -> users.
  await env.DB.exec('DELETE FROM messages; DELETE FROM notifications; DELETE FROM matches; DELETE FROM users;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, email, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'u1@example.com', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, email, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u2', 'sp2', NULL, 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m1', 'u1', 'u2', 1000)`).run();
  await env.DB.prepare(
    `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n1', 'u1', 'match', 'm1', 1000)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n2', 'u2', 'match', 'm1', 1000)`
  ).run();
});

describe('notifyMatch', () => {
  it('emails users who have an email on file and marks email_sent_at', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await notifyMatch(env.DB, { RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'm1');

    const n1 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n1').first<any>();
    const n2 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n2').first<any>();
    expect(n1.email_sent_at).not.toBeNull(); // u1 has an email
    expect(n2.email_sent_at).toBeNull(); // u2 has no email on file — skipped, not an error

    vi.unstubAllGlobals();
  });

  it('never emails a soft-deleted recipient during the grace period', async () => {
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(2000, 'u1').run();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMatch(env.DB, { RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'm1');

    expect(fetchMock).not.toHaveBeenCalled();
    const n1 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n1').first<any>();
    expect(n1.email_sent_at).toBeNull();

    vi.unstubAllGlobals();
  });
});

describe('sendDelayedMatchNotificationEmails', () => {
  // beforeEach already seeds match 'm1' (u1<->u2) with 'match' notifications
  // n1 (u1, has an email) and n2 (u2, no email) both at created_at: 1000.
  const AFTER_DELAY = 1000 + MATCH_NOTIFICATION_DELAY_MS + 1;
  const BEFORE_DELAY = 1000 + 60 * 1000; // 1 minute later -- well inside the window

  it('sends the email once the 15-minute delay has elapsed', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDelayedMatchNotificationEmails({ DB: env.DB, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, AFTER_DELAY);

    expect(fetchMock).toHaveBeenCalledTimes(1); // only u1 has an email on file
    const n1 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n1').first<any>();
    expect(n1.email_sent_at).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it('does not send before the 15-minute delay has elapsed', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDelayedMatchNotificationEmails({ DB: env.DB, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, BEFORE_DELAY);

    expect(fetchMock).not.toHaveBeenCalled();
    const n1 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n1').first<any>();
    expect(n1.email_sent_at).toBeNull();

    vi.unstubAllGlobals();
  });

  it('skips a match that was unmatched within the window -- the "cancel before it ships" case', async () => {
    await env.DB.prepare('UPDATE matches SET unmatched_at = ? WHERE id = ?').bind(1500, 'm1').run();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDelayedMatchNotificationEmails({ DB: env.DB, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, AFTER_DELAY);

    expect(fetchMock).not.toHaveBeenCalled();
    const n1 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n1').first<any>();
    expect(n1.email_sent_at).toBeNull();

    vi.unstubAllGlobals();
  });

  it('does not re-send once the email has already been sent', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDelayedMatchNotificationEmails({ DB: env.DB, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, AFTER_DELAY);
    await sendDelayedMatchNotificationEmails({ DB: env.DB, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, AFTER_DELAY + 1000);

    expect(fetchMock).toHaveBeenCalledTimes(1); // not twice

    vi.unstubAllGlobals();
  });
});

describe('notifyMessage', () => {
  it('emails the recipient and marks the notification sent', async () => {
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm1', 'u2', 'hi', 1000)`).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`
    ).run();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    await notifyMessage(env.DB, { RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'msg1', 'u1');

    const n3 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n3').first<any>();
    expect(n3.email_sent_at).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it('never emails a soft-deleted recipient during the grace period', async () => {
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm1', 'u2', 'hi', 1000)`).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`
    ).run();
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(2000, 'u1').run();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMessage(env.DB, { RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'msg1', 'u1');

    expect(fetchMock).not.toHaveBeenCalled();
    const n3 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n3').first<any>();
    expect(n3.email_sent_at).toBeNull();

    vi.unstubAllGlobals();
  });
});
