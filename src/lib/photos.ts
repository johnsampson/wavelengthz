// Shared primary-photo lookup.
//
// Lifted out of src/routes/peopleSwipes.ts unchanged when group member
// avatars needed the identical thing: the same position-0 rule, the same
// moderation filter, and the same batching. Two copies of a moderation check
// is exactly the sort of duplication that drifts, and a drifted copy here
// means showing a photo that was blocked.

/**
 * Batched form of the old per-candidate primary-photo lookup: one query for
 * the whole pool instead of one DB round trip per candidate rendered.
 */
export async function primaryPhotoUrls(db: D1Database, userIds: string[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (userIds.length === 0) return urls;

  // moderation_status = 'approved': a flagged/blocked position-0 photo is
  // hidden from everyone but its owner (GET /photos/:id) -- excluding it
  // here too avoids handing back a URL that would just 404 for every other
  // candidate viewer. No fallback to a later photo if position 0 isn't
  // approved -- same as showing no photo at all, an already-handled case.
  const rows = await db
    .prepare(
      `SELECT user_id, id FROM user_photos WHERE position = 0 AND moderation_status = 'approved' AND user_id IN (${new Array(userIds.length).fill('?').join(', ')})`
    )
    .bind(...userIds)
    .all<{ user_id: string; id: string }>();

  for (const row of rows.results) urls.set(row.user_id, `/photos/${row.id}`);
  return urls;
}
