// "Your wavelength moved toward ambient this month."
//
// Computed from music_swipes' own timestamps rather than from user_genres.
// That table holds a running TOTAL -- artist_count/track_count/pass_count as
// they stand right now -- with no history, so it can say what someone likes
// but never what changed. Swipes are individually timestamped, so comparing
// two windows of them is the only way to get direction of travel without
// storing a second copy of anything.
//
// Entirely D1. No Spotify call, no new table, no cron.

export const DRIFT_WINDOW_DAYS = 30;

// Below this, a "trend" is noise. Someone who liked two ambient artists in a
// month hasn't moved toward ambient, and telling them they have is the kind
// of confident-but-hollow claim that makes a feature feel fake.
export const MIN_LIKES_FOR_TREND = 3;

// How many risers/fallers to report. A short list reads as an insight; a long
// one reads as a data dump.
const TOP_N = 3;

export interface GenreDrift {
  genre: string;
  /** Right-swipes in the recent window. */
  current: number;
  /** Right-swipes in the window before it. */
  previous: number;
  /** current - previous. Positive is moving toward. */
  change: number;
}

export interface TasteDrift {
  windowDays: number;
  /** Total right-swipes in the recent window -- the sample the rest rests on. */
  likesInWindow: number;
  rising: GenreDrift[];
  falling: GenreDrift[];
  /** True when there simply isn't enough activity to say anything honest. */
  insufficientData: boolean;
}

/**
 * Genre counts for right-swipes between two timestamps.
 *
 * Counts artist swipes and track swipes alike, resolving each to its artist's
 * genres -- a track like is a genre signal in exactly the way an artist like
 * is, and dropping it would ignore most of what an active user does.
 *
 * artist_genres is the source rather than artists.genres (the JSON blob),
 * because it's a real table this can GROUP BY. Both are populated for any
 * artist MusicBrainz enrichment has reached.
 */
async function genreCounts(db: D1Database, userId: string, fromMs: number, toMs: number): Promise<Map<string, number>> {
  const rows = await db
    .prepare(
      `SELECT ag.name AS genre, COUNT(*) AS c
       FROM music_swipes ms
       LEFT JOIN artists a_direct ON ms.item_type = 'artist' AND a_direct.id = ms.item_id
       LEFT JOIN tracks t ON ms.item_type = 'track' AND t.id = ms.item_id
       JOIN artist_genres ag ON ag.artist_id = COALESCE(a_direct.id, t.artist_id)
       WHERE ms.user_id = ?
         AND ms.direction = 'right'
         AND ms.created_at >= ? AND ms.created_at < ?
       GROUP BY ag.name`
    )
    .bind(userId, fromMs, toMs)
    .all<{ genre: string; c: number }>();

  return new Map(rows.results.map((r) => [r.genre, r.c]));
}

/**
 * Compare two equal-length windows of listening and report what moved.
 *
 * Pure given the two count maps, so the ranking rules are testable without a
 * database -- exported for that reason.
 */
export function compareWindows(current: Map<string, number>, previous: Map<string, number>): { rising: GenreDrift[]; falling: GenreDrift[] } {
  const genres = new Set([...current.keys(), ...previous.keys()]);
  const drifts: GenreDrift[] = [];

  for (const genre of genres) {
    const cur = current.get(genre) ?? 0;
    const prev = previous.get(genre) ?? 0;
    if (cur === prev) continue;
    drifts.push({ genre, current: cur, previous: prev, change: cur - prev });
  }

  // Ties broken by genre name so the same data always produces the same list
  // -- an "insight" that reshuffles between two identical loads reads as
  // broken.
  const byChange = (dir: 1 | -1) => (a: GenreDrift, b: GenreDrift) =>
    (b.change - a.change) * dir || a.genre.localeCompare(b.genre);

  return {
    // A riser has to clear the noise floor in the CURRENT window -- that's
    // where the claim is being made. A faller is judged on its previous
    // window for the same reason: the claim is about what they used to play.
    rising: drifts.filter((d) => d.change > 0 && d.current >= MIN_LIKES_FOR_TREND).sort(byChange(1)).slice(0, TOP_N),
    falling: drifts.filter((d) => d.change < 0 && d.previous >= MIN_LIKES_FOR_TREND).sort(byChange(-1)).slice(0, TOP_N),
  };
}

export async function getTasteDrift(db: D1Database, userId: string, now: number = Date.now()): Promise<TasteDrift> {
  const windowMs = DRIFT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentFrom = now - windowMs;
  const priorFrom = now - windowMs * 2;

  const [current, previous, likesRow] = await Promise.all([
    genreCounts(db, userId, recentFrom, now + 1),
    genreCounts(db, userId, priorFrom, recentFrom),
    db
      .prepare(
        `SELECT COUNT(*) as c FROM music_swipes
         WHERE user_id = ? AND direction = 'right' AND created_at >= ?`
      )
      .bind(userId, recentFrom)
      .first<{ c: number }>(),
  ]);

  const likesInWindow = likesRow?.c ?? 0;
  const { rising, falling } = compareWindows(current, previous);

  return {
    windowDays: DRIFT_WINDOW_DAYS,
    likesInWindow,
    rising,
    falling,
    // Say nothing rather than something hollow. A brand-new user has no
    // "drift" -- everything is technically rising from zero, which is true
    // and useless.
    insufficientData: likesInWindow < MIN_LIKES_FOR_TREND,
  };
}
