// Trust & safety gate (issue #36 item 1): a profile with no bio and no
// photo is both a weak signal of a real person behind it and a common shape
// for spam/bot accounts, so messaging (1:1 and group) stays locked until
// both are filled in. Deliberately loose on the bio requirement -- ~20
// characters is "wrote a real sentence," not a content-quality bar.
export const MIN_BIO_LENGTH = 20;

export function hasCompleteProfile(user: { bio: string | null }, photoCount: number): boolean {
  return (user.bio?.trim().length ?? 0) >= MIN_BIO_LENGTH && photoCount > 0;
}

export async function photoCountFor(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) as c FROM user_photos WHERE user_id = ?').bind(userId).first<{ c: number }>();
  return row?.c ?? 0;
}
