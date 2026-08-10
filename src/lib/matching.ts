import type { UserRow } from './session';
import { getMusicProfile, getRightSwipedItemIds } from './profile';
import type { MusicProfile } from './scoring';
import { haversineKm, spotifyOverlap, jaccard, computeBlendedScore } from './scoring';
import { isMutuallyWithinAgeRange, type AgePreferences } from './age';

/** Everything scoring needs about one participant, already loaded. */
export interface ScoringInputs {
  profile: MusicProfile;
  rightSwiped: Set<string>;
}

/**
 * Pure scoring core — no DB access.
 *
 * Split out from `scoreCandidate` so the people-swipe deck can load every
 * participant's profile and right-swipes in a fixed number of batched queries
 * and then score the whole pool in memory. Scoring the deck through
 * `scoreCandidate` instead re-fetched the *caller's* own profile and swipes
 * once per candidate, which is both wasted work and a hard cliff: at 200 pool
 * candidates the route blew past the Workers subrequest limit and the entire
 * deck failed with "Too many subrequests".
 */
export function scoreCandidateFromInputs(
  me: UserRow,
  meInputs: ScoringInputs,
  candidate: UserRow,
  candidateInputs: ScoringInputs,
  alreadyLikedMe: boolean
): { score: number; distanceKm: number } {
  // Still computed and returned -- distanceKm feeds bucketedDistanceLabel
  // for display ("12 miles away") and the caller's own radius filtering.
  // It no longer feeds the score itself; see computeBlendedScore's comment.
  const distanceKm = haversineKm(me.lat!, me.lng!, candidate.lat!, candidate.lng!);

  const score = computeBlendedScore({
    spotifyOverlap: spotifyOverlap(meInputs.profile, candidateInputs.profile),
    musicSwipeOverlap: jaccard(meInputs.rightSwiped, candidateInputs.rightSwiped),
    mutualInterestBoost: alreadyLikedMe ? 1 : 0,
  });

  return { score, distanceKm };
}

/**
 * Single-pair convenience wrapper: loads both sides, then scores. Fine for
 * POST /api/swipe/people (one candidate per request); use
 * `scoreCandidateFromInputs` with batched loads for anything in a loop.
 */
export async function scoreCandidate(
  db: D1Database,
  me: UserRow,
  candidate: UserRow,
  alreadyLikedMe: boolean
): Promise<{ score: number; distanceKm: number }> {
  const [meProfile, candidateProfile, meRightSwiped, candidateRightSwiped] = await Promise.all([
    getMusicProfile(db, me.id),
    getMusicProfile(db, candidate.id),
    getRightSwipedItemIds(db, me.id),
    getRightSwipedItemIds(db, candidate.id),
  ]);

  return scoreCandidateFromInputs(
    me,
    { profile: meProfile, rightSwiped: meRightSwiped },
    candidate,
    { profile: candidateProfile, rightSwiped: candidateRightSwiped },
    alreadyLikedMe
  );
}

export async function createMatchIfMutual(
  db: D1Database,
  swiperId: string,
  targetId: string
): Promise<{ matchId: string } | null> {
  const swipedRightBack = await db
    .prepare(`SELECT 1 FROM people_swipes WHERE swiper_id = ? AND target_id = ? AND direction = 'right'`)
    .bind(swiperId, targetId)
    .first();
  const swipedRightForward = await db
    .prepare(`SELECT 1 FROM people_swipes WHERE swiper_id = ? AND target_id = ? AND direction = 'right'`)
    .bind(targetId, swiperId)
    .first();

  if (!swipedRightBack || !swipedRightForward) return null;

  // Defense in depth: never create a match between a blocked pair, even if
  // mutual right-swipes exist (e.g. inserted before the block, or via a
  // future code path that calls this function directly).
  const blocked = await db
    .prepare(
      `SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`
    )
    .bind(swiperId, targetId, targetId, swiperId)
    .first();
  if (blocked) return null;

  // Defense in depth: GET /api/candidates/people already filters out anyone
  // outside either side's stated age range, but that's a discovery-level
  // display filter -- a client can still call POST /api/swipe/people
  // directly with an arbitrary target_id, bypassing it entirely. Never
  // create a match outside either side's range regardless of how the
  // mutual right-swipes came to exist.
  const [swiperAge, targetAge] = await Promise.all([
    db.prepare('SELECT date_of_birth, age_min, age_max FROM users WHERE id = ?').bind(swiperId).first<AgePreferences>(),
    db.prepare('SELECT date_of_birth, age_min, age_max FROM users WHERE id = ?').bind(targetId).first<AgePreferences>(),
  ]);
  if (swiperAge && targetAge && !isMutuallyWithinAgeRange(swiperAge, targetAge, Date.now())) return null;

  // Defense in depth: never create a match involving a ghosted user
  // (src/lib/reports.ts), even with mutual right-swipes recorded -- ghosting
  // is meant to be invisible to the ghosted person, which specifically means
  // no new interaction (a match) can ever form on their side either.
  const ghosted = await db
    .prepare(`SELECT 1 FROM users WHERE id IN (?, ?) AND ghosted_at IS NOT NULL`)
    .bind(swiperId, targetId)
    .first();
  if (ghosted) return null;

  const [userA, userB] = [swiperId, targetId].sort();
  const matchId = crypto.randomUUID();
  const now = Date.now();

  const insertResult = await db
    .prepare(`INSERT OR IGNORE INTO matches (id, user_a_id, user_b_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(matchId, userA, userB, now, now)
    .run();

  if (insertResult.meta.changes === 0) return null; // match already existed

  for (const recipient of [userA, userB]) {
    await db
      .prepare(`INSERT INTO notifications (id, user_id, type, related_id, created_at, updated_at) VALUES (?, ?, 'match', ?, ?, ?)`)
      .bind(crypto.randomUUID(), recipient, matchId, now, now)
      .run();
  }

  return { matchId };
}
