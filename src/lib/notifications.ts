import { sendEmail } from './email';
import { sendWebPush } from './webPush';

// A match is only surfaced -- bell badge, /notifications list, and the email
// below -- some delay after it's created, so the person who just matched has
// a window to hit "unmatch" (POST /api/matches/:id/unmatch) before the other
// side ever finds out. This does NOT delay the actor's own "It's a match!"
// celebration in the deck -- that's driven directly by the swipe response,
// not this table, so it still fires instantly for whoever completed the
// match. Also used by src/routes/notifications.ts to gate GET
// /api/notifications the same way.
//
// Configurable via MATCH_NOTIFICATION_DELAY_MINUTES (wrangler.toml's [vars]),
// in minutes rather than ms for a human-editable config value; defaults to 5
// if it's ever unset. Takes `env` rather than being a plain constant so it
// can vary per environment without a code change.
const DEFAULT_MATCH_NOTIFICATION_DELAY_MINUTES = 5;

export function getMatchNotificationDelayMs(env: Env): number {
  const minutes = Number(env.MATCH_NOTIFICATION_DELAY_MINUTES ?? DEFAULT_MATCH_NOTIFICATION_DELAY_MINUTES);
  const safeMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_MATCH_NOTIFICATION_DELAY_MINUTES;
  return safeMinutes * 60 * 1000;
}

/**
 * Sends a push notification to every subscription on file for a user.
 * Returns true iff at least one subscription existed and was attempted --
 * "attempted", not "confirmed delivered", matching sendEmail's existing
 * semantics (a successful HTTP response isn't proof of a human reading it).
 * A per-subscription failure is isolated (logged, not thrown) so one dead
 * device never blocks sending to the user's other devices -- same reasoning
 * as this file's other per-recipient isolation below.
 */
export async function sendPushToUser(
  db: D1Database,
  env: Env,
  userId: string,
  payload: { title: string; body: string; url: string }
): Promise<boolean> {
  const subs = await db
    .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .bind(userId)
    .all<{ id: string; endpoint: string; p256dh: string; auth: string }>();

  if (subs.results.length === 0) return false;

  for (const sub of subs.results) {
    try {
      const result = await sendWebPush({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload, env);
      if (!result.ok && result.expired) {
        await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
      }
    } catch (err) {
      console.error(`Push send failed for subscription ${sub.id}:`, err);
    }
  }
  return true;
}

export async function notifyMatch(db: D1Database, env: Env, matchId: string): Promise<void> {
  // `u.deleted_at IS NULL`: a soft-deleted account stays in the users table
  // for the 7-day grace period before the hard purge. Emailing that address
  // in the meantime contradicts the deletion the user just requested.
  // `n.email_sent_at IS NULL`: defense-in-depth so a second call for the same
  // match (the cron sweep below only calls this once per match, but nothing
  // stops a future caller from doing otherwise) never double-emails a
  // recipient who was already sent one.
  const rows = await db
    .prepare(
      `SELECT n.id as notification_id, n.user_id, u.email, u.email_notifications_enabled FROM notifications n
       JOIN users u ON u.id = n.user_id
       WHERE n.related_id = ? AND n.type = 'match' AND u.deleted_at IS NULL AND n.email_sent_at IS NULL`
    )
    .bind(matchId)
    .all<{ notification_id: string; user_id: string; email: string | null; email_notifications_enabled: number }>();

  for (const row of rows.results) {
    const pushed = await sendPushToUser(db, env, row.user_id, {
      title: "You've got a new match!",
      body: 'Open the app to say hi.',
      url: '/matches',
    });

    // Email is the fallback channel, not a second copy of the same
    // notification -- only sent when push wasn't attempted at all (no
    // subscription on file), not when it was attempted and failed
    // mid-send. A transient push failure shouldn't silently escalate into
    // also emailing someone who chose push as their channel. Also gated on
    // the user's own opt-out (Settings → Notifications) -- unlike the push
    // fallback logic above, this one the user can turn off outright.
    if (!pushed && row.email && row.email_notifications_enabled) {
      await sendEmail(env, {
        to: row.email,
        subject: "You've got a new match!",
        html: `<p>You matched with someone on Wavelengthz. Open the app to say hi.</p>`,
      });
    }

    // email_sent_at now doubles as "fully processed for outbound
    // notification" rather than "email specifically sent" -- set whenever
    // either channel was used, so a push-only (no email on file) recipient
    // isn't reprocessed by every future cron sweep the way it would be if
    // this stayed keyed to email alone.
    if (row.email || pushed) {
      const sentAt = Date.now();
      await db.prepare('UPDATE notifications SET email_sent_at = ?, updated_at = ? WHERE id = ?').bind(sentAt, sentAt, row.notification_id).run();
    }
  }
}

export async function notifyMessage(db: D1Database, env: Env, messageId: string, recipientId: string): Promise<void> {
  // Never notify (any channel) an account inside its post-deletion grace
  // period. Unlike before push existed, a missing email no longer
  // short-circuits this early -- a push-only recipient still needs the
  // notification-row check below and a push attempt.
  const recipient = await db
    .prepare('SELECT email, email_notifications_enabled FROM users WHERE id = ? AND deleted_at IS NULL')
    .bind(recipientId)
    .first<{ email: string | null; email_notifications_enabled: number }>();
  if (!recipient) return;

  const notification = await db
    .prepare(`SELECT id FROM notifications WHERE related_id = ? AND type = 'message' AND user_id = ?`)
    .bind(messageId, recipientId)
    .first<{ id: string }>();
  if (!notification) return;

  // /messages (public/messages.html) reads matchId from the query string on
  // load and has nothing to render without it -- a bare '/messages' link
  // lands the recipient on a broken, empty conversation view instead of the
  // actual match they were messaged from.
  const message = await db.prepare('SELECT match_id FROM messages WHERE id = ?').bind(messageId).first<{ match_id: string }>();

  const pushed = await sendPushToUser(db, env, recipientId, {
    title: 'New message on Wavelengthz',
    body: 'Open the app to read it.',
    url: message ? `/messages?matchId=${message.match_id}` : '/messages',
  });

  // See notifyMatch's comment: email is the fallback channel, only sent
  // when push wasn't attempted at all, and gated on the user's own opt-out.
  if (!pushed && recipient.email && recipient.email_notifications_enabled) {
    await sendEmail(env, {
      to: recipient.email,
      subject: 'New message on Wavelengthz',
      html: `<p>You have a new message. Open the app to read it.</p>`,
    });
  }

  if (recipient.email || pushed) {
    const sentAt = Date.now();
    await db.prepare('UPDATE notifications SET email_sent_at = ?, updated_at = ? WHERE id = ?').bind(sentAt, sentAt, notification.id).run();
  }
}

/**
 * Cron sweep (src/index.ts's scheduled()): sends the deferred match-notification
 * emails for every match old enough that the cancellation window (see
 * getMatchNotificationDelayMs) has passed, skipping any match that was
 * unmatched in the meantime -- that's the "cancel before it ships" behavior
 * the delay exists for. Per-match failures are isolated (same reasoning as
 * purgeExpiredDeletions): this runs from ctx.waitUntil, where a thrown error
 * is swallowed with no trace, so one bad match must not block the rest of
 * the batch.
 */
export async function sendDelayedMatchNotificationEmails(env: Env, nowMs: number): Promise<void> {
  const db = env.DB;
  const cutoff = nowMs - getMatchNotificationDelayMs(env);

  // Broadened beyond "has an email" now that push exists: a match where a
  // recipient has no email on file but does have a push subscription must
  // still surface here, or notifyMatch never runs for that match at all and
  // that recipient's push silently never fires.
  const rows = await db
    .prepare(
      `SELECT DISTINCT n.related_id as match_id FROM notifications n
       JOIN users u ON u.id = n.user_id
       WHERE n.type = 'match' AND n.email_sent_at IS NULL AND n.created_at <= ?
         AND (u.email IS NOT NULL OR EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id))`
    )
    .bind(cutoff)
    .all<{ match_id: string }>();

  for (const row of rows.results) {
    const match = await db
      .prepare('SELECT unmatched_at FROM matches WHERE id = ?')
      .bind(row.match_id)
      .first<{ unmatched_at: number | null }>();
    if (!match || match.unmatched_at != null) continue; // cancelled within the window -- never email

    await notifyMatch(db, env, row.match_id);
  }
}
