import { sendEmail } from './email';

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
      `SELECT n.id as notification_id, u.email FROM notifications n
       JOIN users u ON u.id = n.user_id
       WHERE n.related_id = ? AND n.type = 'match' AND u.deleted_at IS NULL AND n.email_sent_at IS NULL`
    )
    .bind(matchId)
    .all<{ notification_id: string; email: string | null }>();

  for (const row of rows.results) {
    if (!row.email) continue;
    await sendEmail(env, {
      to: row.email,
      subject: "You've got a new match!",
      html: `<p>You matched with someone on Wavelengthz. Open the app to say hi.</p>`,
    });
    const sentAt = Date.now();
    await db.prepare('UPDATE notifications SET email_sent_at = ?, updated_at = ? WHERE id = ?').bind(sentAt, sentAt, row.notification_id).run();
  }
}

export async function notifyMessage(db: D1Database, env: Env, messageId: string, recipientId: string): Promise<void> {
  // See notifyMatch: never email an account that's inside its post-deletion
  // grace period.
  const recipient = await db
    .prepare('SELECT email FROM users WHERE id = ? AND deleted_at IS NULL')
    .bind(recipientId)
    .first<{ email: string | null }>();
  if (!recipient?.email) return;

  const notification = await db
    .prepare(`SELECT id FROM notifications WHERE related_id = ? AND type = 'message' AND user_id = ?`)
    .bind(messageId, recipientId)
    .first<{ id: string }>();
  if (!notification) return;

  await sendEmail(env, {
    to: recipient.email,
    subject: 'New message on Wavelengthz',
    html: `<p>You have a new message. Open the app to read it.</p>`,
  });
  const sentAt = Date.now();
  await db.prepare('UPDATE notifications SET email_sent_at = ?, updated_at = ? WHERE id = ?').bind(sentAt, sentAt, notification.id).run();
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

  // Joined to users and filtered on u.email IS NOT NULL: a recipient with no
  // email on file never gets their notification row stamped (notifyMatch
  // skips them without touching email_sent_at, same as it always has), so
  // without this join a match with one no-email participant would keep
  // matching this query -- and keep re-emailing the *other* participant --
  // on every single sweep, forever.
  const rows = await db
    .prepare(
      `SELECT DISTINCT n.related_id as match_id FROM notifications n
       JOIN users u ON u.id = n.user_id
       WHERE n.type = 'match' AND n.email_sent_at IS NULL AND u.email IS NOT NULL AND n.created_at <= ?`
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
