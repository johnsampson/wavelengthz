// Distinct reporters, not total report rows -- otherwise one person could
// unilaterally ghost someone by filing the same report repeatedly. "3 people
// reported them" is the intended threshold, not "3 reports from anyone."
export const GHOST_REPORT_THRESHOLD = 3;

async function distinctReporterCount(db: D1Database, reportedId: string): Promise<number> {
  // status != 'dismissed': a report an admin has already reviewed and
  // rejected as unfounded shouldn't count toward ghosting. There's no
  // admin-review UI yet (every report defaults to and stays 'open'), so
  // this is currently equivalent to counting everything -- but it's the
  // correct semantics for whenever that review flow exists.
  const row = await db
    .prepare(`SELECT COUNT(DISTINCT reporter_id) as c FROM reports WHERE reported_id = ? AND status != 'dismissed'`)
    .bind(reportedId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Called after inserting a new report. Sets ghosted_at the moment a user's
 * distinct-reporter count reaches GHOST_REPORT_THRESHOLD, if not already
 * set. Ghosting is deliberately invisible to the ghosted user -- see
 * migrations/0005_add_ghosted_at.sql -- so this never surfaces a status
 * anywhere the reported user could see it.
 */
export async function maybeGhostUser(db: D1Database, reportedId: string, now: number): Promise<void> {
  const count = await distinctReporterCount(db, reportedId);
  if (count < GHOST_REPORT_THRESHOLD) return;

  await db.prepare('UPDATE users SET ghosted_at = ? WHERE id = ? AND ghosted_at IS NULL').bind(now, reportedId).run();
}
