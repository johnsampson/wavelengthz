import { sendEmail } from './email';

export async function notifyMatch(db: D1Database, env: Env, matchId: string): Promise<void> {
  // `u.deleted_at IS NULL`: a soft-deleted account stays in the users table
  // for the 7-day grace period before the hard purge. Emailing that address
  // in the meantime contradicts the deletion the user just requested.
  const rows = await db
    .prepare(
      `SELECT n.id as notification_id, u.email FROM notifications n
       JOIN users u ON u.id = n.user_id
       WHERE n.related_id = ? AND n.type = 'match' AND u.deleted_at IS NULL`
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
    await db.prepare('UPDATE notifications SET email_sent_at = ? WHERE id = ?').bind(Date.now(), row.notification_id).run();
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
  await db.prepare('UPDATE notifications SET email_sent_at = ? WHERE id = ?').bind(Date.now(), notification.id).run();
}
