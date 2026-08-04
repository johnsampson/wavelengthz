export async function isBlockedEitherDirection(db: D1Database, aId: string, bId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`
    )
    .bind(aId, bId, bId, aId)
    .first();
  return !!row;
}
