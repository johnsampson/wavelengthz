// Trust & safety gate (issue #36 item 1, expanded): messaging (1:1 and
// group) stays locked until a user has demonstrated they're a real,
// invested person -- a bio, several photos, meaningful listening activity,
// and a verified phone number (src/routes/phone.ts, Twilio Verify --
// blocks VOIP numbers before an OTP is ever sent). Each threshold is
// deliberately loose, not a content-quality bar: MIN_BIO_LENGTH is "wrote a
// real sentence," MIN_PHOTOS/MIN_ARTISTS_ACTED are "used the app for more
// than a minute," not curated-profile bars.
export const MIN_BIO_LENGTH = 20;
export const MIN_PHOTOS = 3;
// Issue #145 (Round 7): "let's change the criteria for messaging from
// liking 25 songs to acting on 50 artists that includes passing or liking
// or skipping." Was MIN_LIKED_SONGS = 25, counting right-swiped tracks only
// -- replaced outright, not layered alongside it, since the whole point is
// a broader, easier-to-hit signal (any verdict on an artist, not just a
// track like) rather than a stricter one.
export const MIN_ARTISTS_ACTED = 50;

export interface MessagingRequirements {
  bio: boolean;
  photos: boolean;
  artistsActed: boolean;
  phone: boolean;
}

export function messagingRequirements(
  user: { bio: string | null; phone_verified_at: number | null },
  photoCount: number,
  artistsActedCount: number
): MessagingRequirements {
  return {
    bio: (user.bio?.trim().length ?? 0) >= MIN_BIO_LENGTH,
    photos: photoCount >= MIN_PHOTOS,
    artistsActed: artistsActedCount >= MIN_ARTISTS_ACTED,
    phone: user.phone_verified_at != null,
  };
}

export function hasCompleteProfile(
  user: { bio: string | null; phone_verified_at: number | null },
  photoCount: number,
  artistsActedCount: number
): boolean {
  const r = messagingRequirements(user, photoCount, artistsActedCount);
  return r.bio && r.photos && r.artistsActed && r.phone;
}

export async function photoCountFor(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) as c FROM user_photos WHERE user_id = ?').bind(userId).first<{ c: number }>();
  return row?.c ?? 0;
}

// Issue #145 (Round 7): counts every artist a user has *acted on* -- liked,
// passed, or skipped, not liked-tracks-only like the previous
// likedSongCountFor. music_swipes' (user_id, item_type, item_id) unique
// constraint (migrations/0001) already guarantees one row per artist per
// user regardless of how many times its direction has changed, so a plain
// COUNT is exactly "how many distinct artists has this user acted on" --
// no DISTINCT needed. Not filtered by direction: VALID_DIRECTIONS
// (src/routes/musicSwipes.ts) only ever allows 'left'/'right'/'skip', so
// every row here is already one of the three the ask names.
export async function artistsActedCountFor(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as c FROM music_swipes WHERE user_id = ? AND item_type = 'artist'`)
    .bind(userId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}
