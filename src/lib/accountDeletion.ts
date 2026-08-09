// Deviation from the plan's literal design note, and why:
//
// docs/PLAN.md §9 (and this task's brief) call for keeping `reports` rows where the
// deleted user was the *reported* party, with `reported_id` left pointing at the
// now-purged id, on the assumption that "SQLite/D1 permits [dangling FKs] since foreign
// keys aren't enforced by default." That assumption does not hold here: this D1 instance
// enforces `PRAGMA foreign_keys` unconditionally, `reports.reported_id` is a NOT NULL
// `REFERENCES users(id)` column with no ON DELETE clause, and D1 does not honor
// `PRAGMA foreign_keys = OFF` (verified empirically — the DELETE still throws
// SQLITE_CONSTRAINT_FOREIGNKEY even with the pragma issued first, alone or combined
// into one exec() call). So a genuine `DELETE FROM users` while any report still
// references the row as `reported_id` is rejected outright; there is no way to leave
// the id dangling.
//
// To honor the underlying intent (moderation record continuity — the report survives
// account deletion) without violating the FK graph, "kept" reports are re-pointed at a
// permanent tombstone user row instead of the real (now-deleted) id. The tombstone is
// never onboarded and never soft-deleted, so it's inert everywhere else in the app:
// `getSessionUser` only matches rows with an active session (never created for it),
// and the people-swipe candidate/target queries require `onboarded_at IS NOT NULL`,
// which the tombstone never has.
import { reportError } from './sentry';

const TOMBSTONE_USER_ID = '00000000-0000-0000-0000-000000000000';
const TOMBSTONE_SPOTIFY_ID = '__wavelengthz_deleted_user_tombstone__';

// access_token/refresh_token/token_expires_at are dropped by Task 1's
// migration, so they're no longer supplied here. spotify_id stays --
// Task 1's migration note explains it's a platform constraint that it
// can't be dropped from users, so it's still UNIQUE NOT NULL. No
// auth_identities/music_source_tokens row is needed -- the tombstone
// never logs in, and nothing requires a user to have either.
async function ensureTombstoneUser(env: Env): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, spotify_id, created_at, updated_at) VALUES (?, ?, 0, 0)`)
    .bind(TOMBSTONE_USER_ID, TOMBSTONE_SPOTIFY_ID)
    .run();
}

export async function hardDeleteUser(env: Env, userId: string): Promise<void> {
  const now = Date.now();
  const photos = await env.DB.prepare('SELECT r2_key FROM user_photos WHERE user_id = ?').bind(userId).all<{ r2_key: string }>();
  for (const photo of photos.results) {
    await env.PHOTOS.delete(photo.r2_key);
  }
  await env.DB.prepare('DELETE FROM user_photos WHERE user_id = ?').bind(userId).run();

  const matches = await env.DB.prepare('SELECT id FROM matches WHERE user_a_id = ? OR user_b_id = ?').bind(userId, userId).all<{ id: string }>();
  for (const match of matches.results) {
    await env.DB.prepare('DELETE FROM messages WHERE match_id = ?').bind(match.id).run();
    await env.DB.prepare('DELETE FROM matches WHERE id = ?').bind(match.id).run();
  }

  await env.DB.prepare('DELETE FROM people_swipes WHERE swiper_id = ? OR target_id = ?').bind(userId, userId).run();
  await env.DB.prepare('DELETE FROM music_swipes WHERE user_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM user_genres WHERE user_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM music_profiles WHERE user_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?').bind(userId, userId).run();

  // The deleted user's own filed reports are no longer actionable — delete them.
  await env.DB.prepare('DELETE FROM reports WHERE reporter_id = ?').bind(userId).run();
  // Reports where the deleted user was the *reported* party are kept for moderation
  // continuity, but must be re-pointed at the tombstone (see module comment above) —
  // `reported_id` can't be left referencing a row we're about to delete.
  await ensureTombstoneUser(env);
  await env.DB.prepare('UPDATE reports SET reported_id = ?, updated_at = ? WHERE reported_id = ?').bind(TOMBSTONE_USER_ID, now, userId).run();

  await env.DB.prepare('DELETE FROM notifications WHERE user_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();

  // Catalog rows (artists/tracks a user added via search-and-add) outlive the user;
  // added_by_user_id is nullable, so null it rather than leaving it dangling.
  await env.DB.prepare('UPDATE artists SET added_by_user_id = NULL, updated_at = ? WHERE added_by_user_id = ?').bind(now, userId).run();
  await env.DB.prepare('UPDATE tracks SET added_by_user_id = NULL, updated_at = ? WHERE added_by_user_id = ?').bind(now, userId).run();

  await env.DB.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM music_source_tokens WHERE user_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
}

/**
 * Hard-deletes every account whose grace period has expired.
 *
 * Per-user failures are isolated rather than fatal. This runs from a cron via
 * `ctx.waitUntil(...)`, where a rejection is swallowed with no trace: a single
 * bad user (a transient R2/D1 error, or the subrequest limit on a big night)
 * used to abort the rest of the batch, and the unpurged accounts would just
 * accumulate indefinitely with nobody the wiser. Each failure is reported to
 * Sentry and surfaced in the return value; the batch continues. Failed users
 * still have `deleted_at` set, so the next nightly run retries them.
 */
export async function purgeExpiredDeletions(
  env: Env,
  gracePeriodMs: number,
  nowMs: number
): Promise<{ purgedCount: number; failedIds: string[] }> {
  const cutoff = nowMs - gracePeriodMs;
  const rows = await env.DB.prepare(
    'SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at < ? AND id != ?'
  )
    .bind(cutoff, TOMBSTONE_USER_ID)
    .all<{ id: string }>();

  let purgedCount = 0;
  const failedIds: string[] = [];

  for (const row of rows.results) {
    try {
      await hardDeleteUser(env, row.id);
      purgedCount += 1;
    } catch (error) {
      failedIds.push(row.id);
      // reportError is documented never to throw, so this can't itself take
      // down the batch.
      await reportError(env, error, { path: `scheduled:purgeExpiredDeletions:${row.id}` });
    }
  }

  return { purgedCount, failedIds };
}
