// Viewer-specific ordering for an artist's track list.
//
// Kept as its own module, taking an already-built list plus a set of liked
// ids, specifically so the expensive part of GET /api/artists/:id stays
// viewer-independent. That route's track assembly (fetchArtistTracksCached,
// the D1 catalog read, the upsert loop) produces the same result for every
// viewer and is therefore cacheable; only this final reorder differs per
// person. Issue #72 asked for liked songs on top "ideally set up so we can
// cache it properly later" -- keeping the personalization as a pure function
// over the cacheable list is what makes that possible, rather than baking a
// per-viewer ORDER BY into the query.

/** Anything with an internal id -- the shape both call sites already have. */
interface Orderable {
  internalId: string;
}

/**
 * Move the viewer's liked tracks to the front, preserving the underlying
 * order within both groups.
 *
 * Stable on purpose: the incoming order is `rowid` (roughly release order,
 * the same ordering the artist page and radio already use), and that should
 * survive inside the liked block and the rest alike. A track the viewer
 * passed on or skipped is not "liked" -- only an explicit right-swipe counts
 * -- and stays exactly where it was relative to untouched tracks.
 */
export function likedFirst<T extends Orderable>(tracks: T[], likedIds: Set<string>): T[] {
  if (likedIds.size === 0) return tracks;
  const liked: T[] = [];
  const rest: T[] = [];
  for (const track of tracks) {
    (likedIds.has(track.internalId) ? liked : rest).push(track);
  }
  return [...liked, ...rest];
}

/**
 * Every track by this artist the viewer has right-swiped.
 *
 * Deliberately queried by artist rather than filtered from the page's current
 * track window. A liked track can sit well outside the fetched slice -- like
 * track 45 of a discography, then load a page showing 30 -- and "liked songs
 * on top" that silently omits it is the wrong feature. Pure D1 and indexed on
 * both sides; a liked track is by definition already in the catalog, so this
 * costs no Spotify call.
 */
export async function likedTrackIdsForArtist(db: D1Database, userId: string, artistInternalId: string): Promise<Set<string>> {
  const rows = await db
    .prepare(
      `SELECT ms.item_id as id
       FROM music_swipes ms
       JOIN tracks t ON t.id = ms.item_id
       WHERE ms.user_id = ? AND ms.item_type = 'track' AND ms.direction = 'right' AND t.artist_id = ?`
    )
    .bind(userId, artistInternalId)
    .all<{ id: string }>();
  return new Set(rows.results.map((r) => r.id));
}
