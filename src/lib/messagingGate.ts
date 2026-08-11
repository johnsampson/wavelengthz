// Trust & safety gate (issue #36 item 1, expanded): messaging (1:1 and
// group) stays locked until a user has demonstrated they're a real,
// invested person -- a bio, several photos, meaningful listening activity,
// and a verified phone number (src/routes/phone.ts, Twilio Verify --
// blocks VOIP numbers before an OTP is ever sent). Each threshold is
// deliberately loose, not a content-quality bar: MIN_BIO_LENGTH is "wrote a
// real sentence," MIN_PHOTOS/MIN_LIKED_SONGS are "used the app for more
// than a minute," not curated-profile bars.
export const MIN_BIO_LENGTH = 20;
export const MIN_PHOTOS = 3;
export const MIN_LIKED_SONGS = 25;

export interface MessagingRequirements {
  bio: boolean;
  photos: boolean;
  likedSongs: boolean;
  phone: boolean;
}

export function messagingRequirements(
  user: { bio: string | null; phone_verified_at: number | null },
  photoCount: number,
  likedSongCount: number
): MessagingRequirements {
  return {
    bio: (user.bio?.trim().length ?? 0) >= MIN_BIO_LENGTH,
    photos: photoCount >= MIN_PHOTOS,
    likedSongs: likedSongCount >= MIN_LIKED_SONGS,
    phone: user.phone_verified_at != null,
  };
}

export function hasCompleteProfile(
  user: { bio: string | null; phone_verified_at: number | null },
  photoCount: number,
  likedSongCount: number
): boolean {
  const r = messagingRequirements(user, photoCount, likedSongCount);
  return r.bio && r.photos && r.likedSongs && r.phone;
}

export async function photoCountFor(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) as c FROM user_photos WHERE user_id = ?').bind(userId).first<{ c: number }>();
  return row?.c ?? 0;
}

// "Liked" mirrors every other right-swipe-count query in this codebase
// (e.g. src/routes/catalog.ts's totalLikes) -- a track right-swipe, not an
// artist one. Liking a track auto-likes its artist too
// (src/routes/musicSwipes.ts's likeArtistForTrack), but the reverse isn't
// true, so counting tracks specifically is the tighter, more deliberate
// signal of the two.
export async function likedSongCountFor(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as c FROM music_swipes WHERE user_id = ? AND item_type = 'track' AND direction = 'right'`)
    .bind(userId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}
