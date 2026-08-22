import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { notifyMatch, notifyMessage, sendDelayedMatchNotificationEmails, getMatchNotificationDelayMs } from '../../src/lib/notifications';
import * as webPush from '../../src/lib/webPush';
import { insertTestUser } from '../helpers/createUser';

async function insertPushSubscription(db: D1Database, userId: string, endpoint: string) {
  await db
    .prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), userId, endpoint, 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', Date.now(), Date.now())
    .run();
}

const VAPID_TEST_ENV = { VAPID_PUBLIC_KEY: 'BC-IIfT4yho1Lp9x06rIRv0bo-Ns2hq77fpxI61ELRF2DQm0TxTLnyzHcWd2QRB6vJyJIN1gGG8In355vJGGF5E', VAPID_PRIVATE_KEY: 'myv3AP-P0PyJxUMi2NBShq7cAodxuEcOg1iuAYO5Q2I', VAPID_SUBJECT: 'mailto:test@example.com' };

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  // Child rows before parent `users` rows -- D1 enforces FK constraints here.
  // messages -> matches, users; notifications -> users; matches -> users.
  await env.DB.exec('DELETE FROM messages; DELETE FROM notifications; DELETE FROM push_subscriptions; DELETE FROM matches; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', email: 'u1@example.com', createdAt: 1000, updatedAt: 1000 });
  await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp2', email: null, createdAt: 1000, updatedAt: 1000 });
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

  it('does not email a recipient who has opted out of email notifications, but still marks the notification processed', async () => {
    await env.DB.prepare('UPDATE users SET email_notifications_enabled = 0 WHERE id = ?').bind('u1').run();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMatch(env.DB, { RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'm1');

    expect(fetchMock).not.toHaveBeenCalledWith('https://api.resend.com/emails', expect.anything());
    const n1 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n1').first<any>();
    expect(n1.email_sent_at).not.toBeNull(); // still marked processed -- opted out is a decision, not a failure

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

  it('pushes to a recipient with no email on file and marks the notification processed', async () => {
    await insertPushSubscription(env.DB, 'u2', 'https://push.example/u2-device');
    const fetchMock = vi.fn(async (url: string) => new Response('', { status: url.includes('push.example') ? 201 : 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMatch(env.DB, { ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'm1');

    expect(fetchMock).toHaveBeenCalledWith('https://push.example/u2-device', expect.anything());
    const n2 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n2').first<any>();
    expect(n2.email_sent_at).not.toBeNull(); // processed via push even with no email

    vi.unstubAllGlobals();
  });

  it('sends push only, skipping email, when a recipient has both a push subscription and an email on file', async () => {
    // Issue #45: email is a fallback for people without push, not a second
    // copy of every notification once push exists.
    await insertPushSubscription(env.DB, 'u1', 'https://push.example/u1-device');
    const fetchMock = vi.fn(async (url: string) => new Response('', { status: url.includes('push.example') ? 201 : 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMatch(env.DB, { ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'm1');

    expect(fetchMock).toHaveBeenCalledWith('https://push.example/u1-device', expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith('https://api.resend.com/emails', expect.anything());
    const n1 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n1').first<any>();
    expect(n1.email_sent_at).not.toBeNull(); // still marked processed -- via push, not email

    vi.unstubAllGlobals();
  });

  it('deletes an expired (410) subscription but keeps sending to the recipient\'s other devices', async () => {
    await insertPushSubscription(env.DB, 'u2', 'https://push.example/u2-dead');
    await insertPushSubscription(env.DB, 'u2', 'https://push.example/u2-alive');
    const fetchMock = vi.fn(async (url: string) => new Response('', { status: url.includes('u2-dead') ? 410 : 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMatch(env.DB, { ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'm1');

    const remaining = await env.DB.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?').bind('u2').all<any>();
    expect(remaining.results.map((r: any) => r.endpoint)).toEqual(['https://push.example/u2-alive']);

    vi.unstubAllGlobals();
  });
});

describe('sendDelayedMatchNotificationEmails', () => {
  // beforeEach already seeds match 'm1' (u1<->u2) with 'match' notifications
  // n1 (u1, has an email) and n2 (u2, no email) both at created_at: 1000.
  // The fake env below (no MATCH_NOTIFICATION_DELAY_MINUTES) matches exactly
  // what sendDelayedMatchNotificationEmails is actually called with further
  // down, so this resolves to whatever the default fallback is regardless of
  // its value.
  const DELAY_MS = getMatchNotificationDelayMs({} as any);
  const AFTER_DELAY = 1000 + DELAY_MS + 1;
  const BEFORE_DELAY = 1000 + 60 * 1000; // 1 minute later -- well inside the window

  it('sends the email once the delay has elapsed', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDelayedMatchNotificationEmails({ DB: env.DB, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, AFTER_DELAY);

    expect(fetchMock).toHaveBeenCalledTimes(1); // only u1 has an email on file
    const n1 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n1').first<any>();
    expect(n1.email_sent_at).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it('does not send before the delay has elapsed', async () => {
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

  it('surfaces a match whose only email-eligible-or-push-eligible recipient has push but no email', async () => {
    await env.DB.exec(`DELETE FROM notifications; DELETE FROM push_subscriptions;`);
    await env.DB.prepare(`UPDATE users SET email = NULL WHERE id IN ('u1', 'u2')`).run();
    await insertPushSubscription(env.DB, 'u2', 'https://push.example/u2-device');
    await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n-push-only', 'u2', 'match', 'm1', 1000)`).run();

    const fetchMock = vi.fn(async () => new Response('', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDelayedMatchNotificationEmails({ DB: env.DB, ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, AFTER_DELAY);

    expect(fetchMock).toHaveBeenCalledWith('https://push.example/u2-device', expect.anything());

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

  it('does not email a recipient who has opted out of email notifications, but still marks the notification processed', async () => {
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm1', 'u2', 'hi', 1000)`).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`
    ).run();
    await env.DB.prepare('UPDATE users SET email_notifications_enabled = 0 WHERE id = ?').bind('u1').run();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMessage(env.DB, { RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'msg1', 'u1');

    expect(fetchMock).not.toHaveBeenCalledWith('https://api.resend.com/emails', expect.anything());
    const n3 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n3').first<any>();
    expect(n3.email_sent_at).not.toBeNull(); // still marked processed -- opted out is a decision, not a failure

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

  it('pushes to the recipient even when they have no email on file', async () => {
    await env.DB.prepare(`UPDATE users SET email = NULL WHERE id = 'u1'`).run();
    await insertPushSubscription(env.DB, 'u1', 'https://push.example/u1-device');
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm1', 'u2', 'hi', 1000)`).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`
    ).run();
    const fetchMock = vi.fn(async () => new Response('', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMessage(env.DB, { ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'msg1', 'u1');

    expect(fetchMock).toHaveBeenCalledWith('https://push.example/u1-device', expect.anything());
    const n3 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n3').first<any>();
    expect(n3.email_sent_at).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it('sends push only, skipping email, when the recipient has both a push subscription and an email on file', async () => {
    // Issue #45: email is a fallback for people without push, not a second
    // copy of every notification once push exists. u1 keeps its email from
    // beforeEach here (not nulled), unlike the other push-focused tests above.
    await insertPushSubscription(env.DB, 'u1', 'https://push.example/u1-device');
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm1', 'u2', 'hi', 1000)`).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`
    ).run();
    const fetchMock = vi.fn(async (url: string) => new Response('', { status: url.includes('push.example') ? 201 : 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMessage(env.DB, { ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'msg1', 'u1');

    expect(fetchMock).toHaveBeenCalledWith('https://push.example/u1-device', expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith('https://api.resend.com/emails', expect.anything());
    const n3 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n3').first<any>();
    expect(n3.email_sent_at).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it('sends a push whose url deep-links to the message\'s specific match, not the bare /messages page', async () => {
    // Regression: public/messages.html reads matchId from the query string
    // and can't render anything without it -- a bare '/messages' url left
    // every real message push landing on a broken, empty conversation view.
    // Spies on sendWebPush (the layer right before encryption/network) since
    // the actual wire payload is AES-GCM encrypted and opaque to a fetch mock.
    await env.DB.prepare(`UPDATE users SET email = NULL WHERE id = 'u1'`).run();
    await insertPushSubscription(env.DB, 'u1', 'https://push.example/u1-device');
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm1', 'u2', 'hi', 1000)`).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`
    ).run();
    const sendWebPushSpy = vi.spyOn(webPush, 'sendWebPush').mockResolvedValue({ ok: true });

    await notifyMessage(env.DB, { ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'msg1', 'u1');

    expect(sendWebPushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://push.example/u1-device' }),
      expect.objectContaining({ url: '/messages?matchId=m1' }),
      expect.anything()
    );

    sendWebPushSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('names the sender and the track in a shared-song push', async () => {
    await env.DB.prepare(`UPDATE users SET display_name = 'Jordan' WHERE id = 'u2'`).run();
    await env.DB.prepare(`UPDATE users SET email = NULL WHERE id = 'u1'`).run();
    await insertPushSubscription(env.DB, 'u1', 'https://push.example/u1-device');
    await env.DB.prepare(
      `INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('art-song', 'The Artist', '[]', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, source, approved, created_at) VALUES ('trk-song', 'sp-trk-song', 'The Song', 'art-song', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO messages (id, match_id, sender_id, body, track_id, created_at) VALUES ('msg1', 'm1', 'u2', '', 'trk-song', 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`
    ).run();
    const sendWebPushSpy = vi.spyOn(webPush, 'sendWebPush').mockResolvedValue({ ok: true });

    await notifyMessage(env.DB, { ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'msg1', 'u1');

    expect(sendWebPushSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'Jordan sent you a song', body: 'The Song by The Artist' }),
      expect.anything()
    );

    sendWebPushSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('names the sender in a plain text message push', async () => {
    await env.DB.prepare(`UPDATE users SET display_name = 'Jordan' WHERE id = 'u2'`).run();
    await env.DB.prepare(`UPDATE users SET email = NULL WHERE id = 'u1'`).run();
    await insertPushSubscription(env.DB, 'u1', 'https://push.example/u1-device');
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm1', 'u2', 'hi', 1000)`).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`
    ).run();
    const sendWebPushSpy = vi.spyOn(webPush, 'sendWebPush').mockResolvedValue({ ok: true });

    await notifyMessage(env.DB, { ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'msg1', 'u1');

    expect(sendWebPushSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'New message from Jordan' }),
      expect.anything()
    );

    sendWebPushSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('falls back to a generic sender label when the sender has no display_name set', async () => {
    // u2 (this file's beforeEach) is created with no displayName -- same
    // fallback text public/messages.js and matches.ts's otherDisplayName
    // already use, so a push never contradicts what the thread shows.
    const sendWebPushSpy = vi.spyOn(webPush, 'sendWebPush').mockResolvedValue({ ok: true });
    await env.DB.prepare(`UPDATE users SET email = NULL WHERE id = 'u1'`).run();
    await insertPushSubscription(env.DB, 'u1', 'https://push.example/u1-device');
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm1', 'u2', 'hi', 1000)`).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`
    ).run();

    await notifyMessage(env.DB, { ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'msg1', 'u1');

    expect(sendWebPushSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'New message from Wavelengthz user' }),
      expect.anything()
    );

    sendWebPushSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('escapes HTML in the sender name and track title in the email fallback', async () => {
    // Both a display_name and a Spotify track/artist name are
    // user/third-party controlled text now interpolated into an HTML email
    // body -- unescaped, either could break the markup or inject content.
    await env.DB.prepare(`UPDATE users SET display_name = '<b>Jordan</b>' WHERE id = 'u2'`).run();
    await env.DB.prepare(
      `INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('art-xss', '<i>Artist</i>', '[]', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, source, approved, created_at) VALUES ('trk-xss', 'sp-trk-xss', '<script>alert(1)</script>', 'art-xss', 'seed', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO messages (id, match_id, sender_id, body, track_id, created_at) VALUES ('msg1', 'm1', 'u2', '', 'trk-xss', 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`
    ).run();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMessage(env.DB, { RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'msg1', 'u1');

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(sentBody.html).not.toContain('<script>');
    expect(sentBody.html).toContain('&lt;script&gt;');
    expect(sentBody.html).toContain('&lt;b&gt;Jordan&lt;/b&gt;');

    vi.unstubAllGlobals();
  });
});
