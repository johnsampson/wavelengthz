import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser, type UserRow } from '../lib/session';
import { scoreCandidate, scoreCandidateFromInputs, createMatchIfMutual, type ScoringInputs } from '../lib/matching';
import { getMusicProfiles, getRightSwipedItemIdsFor, getAnthemTracksForUsers, pickAnthemTrack } from '../lib/profile';
import type { MusicProfile } from '../lib/scoring';
import { bucketedDistanceLabel, haversineKm } from '../lib/scoring';
import { isBlockedEitherDirection } from '../lib/blocks';
import { computeMusicOverlap, MusicOverlap } from '../lib/musicOverlap';
import { getDisplayMusicProfile } from '../lib/profile';
import { getMatchNotificationDelayMs } from '../lib/notifications';
import { isMutuallyWithinAgeRange } from '../lib/age';
import { primaryPhotoUrls } from '../lib/photos';

// Hard cap on the like-priority queue. It previously had no LIMIT at all, so a
// popular account's deck request grew without bound.
const LIKE_PRIORITY_LIMIT = 50;
const POOL_LIMIT = 200;

// Coarse latitude band used to pre-filter the pool in SQL. ~111km per degree
// of latitude everywhere on the globe, so this never excludes anyone who is
// actually within range; the exact haversine check in JS does the real
// exclusion. Longitude is deliberately *not* bounded in SQL: the degrees-per-km
// factor varies with cos(latitude) and the band wraps incorrectly across the
// antimeridian, which would silently drop valid candidates.
const KM_PER_DEGREE_LATITUDE = 111;

const RECENT_MUSIC_LIMIT = 10;

// Mutual gender/seeking reciprocity, as a SQL fragment reused by both the
// like-priority and pool queries below. "Friends" (src/routes/onboarding.ts's
// SEEKING_OPTIONS) is a seeking-only value -- there's no matching gender, by
// design, so it can never satisfy the normal `u.gender = me.seeking` check.
// Two friends-seekers match each other regardless of gender; everyone else
// keeps today's exact reciprocity untouched. Params, in order: me.seeking,
// me.seeking, me.gender.
const RECIPROCITY_SQL = `(u.seeking = 'friends' AND ? = 'friends') OR (u.gender = ? AND u.seeking = ?)`;

// Symmetric to musicSwipes.ts's own blockedGenreFilter, applied here so a
// genre `me` has explicitly hidden from their music deck (user_blocked_
// genres, src/routes/genreBlocks.ts) doesn't also keep surfacing people
// whose own top genres are dominated by it -- previously this had zero
// effect on People mode at all: blocking a genre only ever filtered
// music-deck candidates, so the very next batch of people candidates could
// (and did) still be full of people tagged with the genre just blocked.
// A hard eligibility filter (excludes the candidate outright), not a
// scoring nudge, applied to both the like-priority and pool queries below --
// consistent with how every other exclusion criterion in this function
// works (distance/age/blocks all apply to both pools too), rather than a
// special case that only demotes score and could still let a heavily-
// overlapping candidate rank near the top anyway. music_profiles.top_genres
// is a JSON *array* (unlike artists.genres, an object map keyed by genre --
// see genresFromRow), so json_each is read via `je.value`, not `je.key`. A
// candidate with no music_profiles row yet has nothing to conflict with, so
// this never excludes them. Params, in order: me.id.
const GENRE_BLOCK_FILTER = `AND NOT EXISTS (
  SELECT 1 FROM music_profiles mp, json_each(mp.top_genres) je
  WHERE mp.user_id = u.id AND je.value IN (SELECT genre FROM user_blocked_genres WHERE user_id = ?)
)`;
function reciprocityParams(me: Pick<UserRow, 'gender' | 'seeking'>): [string, string, string] {
  return [me.seeking!, me.seeking!, me.gender!];
}

interface RecentMusicItem {
  id: string;
  name: string;
  imageUrl: string | null;
  // Only present for tracks -- the real Spotify id, for the embed player.
  // Distinct from `id` (our internal catalog UUID) since migrations/0002
  // obfuscated it. Artists have no player, so it's omitted there.
  spotifyId?: string;
  // Track's own artist name -- also track-only, same reasoning as spotifyId.
  artistName?: string | null;
}

/**
 * A profile owner's own most-recently right-swiped artists/tracks, for the
 * self-preview view. Unlike computeMusicOverlap this isn't comparing two
 * users -- just the one user's own recent taste.
 */
async function recentRightSwipedItems(
  db: D1Database,
  userId: string,
  itemType: 'artist' | 'track',
  limit: number
): Promise<RecentMusicItem[]> {
  const imageColumn = itemType === 'track' ? 't.album_image_url' : 'a.image_url';
  const rows = await db
    .prepare(
      `SELECT ms.item_id as id, COALESCE(a.name, t.name) as name, ${imageColumn} as image_url,
              COALESCE(a.spotify_id, t.spotify_id) as spotify_id, ta.name as track_artist_name
       FROM music_swipes ms
       LEFT JOIN artists a ON ms.item_type = 'artist' AND a.id = ms.item_id
       LEFT JOIN tracks t ON ms.item_type = 'track' AND t.id = ms.item_id
       LEFT JOIN artists ta ON ms.item_type = 'track' AND ta.id = t.artist_id
       WHERE ms.user_id = ? AND ms.item_type = ? AND ms.direction = 'right'
       ORDER BY ms.created_at DESC
       LIMIT ?`
    )
    .bind(userId, itemType, limit)
    .all<{ id: string; name: string; image_url: string | null; spotify_id: string | null; track_artist_name: string | null }>();

  return rows.results.map((r) =>
    itemType === 'track'
      ? { id: r.id, name: r.name, imageUrl: r.image_url, spotifyId: r.spotify_id!, artistName: r.track_artist_name }
      : { id: r.id, name: r.name, imageUrl: r.image_url }
  );
}


/**
 * Assembles one participant's scoring inputs from the batched lookups. A user
 * absent from either map simply has nothing cached yet, which scores the same
 * as the empty profile/swipe set the single-row loaders return.
 */
function inputsFor(
  userId: string,
  profiles: Map<string, MusicProfile>,
  swipes: Map<string, Set<string>>
): ScoringInputs {
  return {
    profile: profiles.get(userId) ?? { topArtists: [], topGenres: [] },
    rightSwiped: swipes.get(userId) ?? new Set<string>(),
  };
}

// Guards against the "Null Island" bug: `haversineKm` doesn't throw on a null
// lat/lng, JS silently coerces null to 0, so an unonboarded caller would
// otherwise get scored as if they were at (0, 0) with no error.
function hasCompletedOnboarding(user: UserRow): boolean {
  return user.onboarded_at != null && user.lat != null && user.lng != null;
}

export function registerPeopleSwipeRoutes(router: RouterType) {
  router.get('/api/candidates/people', async (request: Request, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    // gender/seeking are required at onboarding going forward, but existing
    // accounts that onboarded before that migration may still have them
    // null -- mutual matching is undefined without both sides set, so treat
    // it the same as an incomplete profile rather than showing a broken pool.
    if (!hasCompletedOnboarding(me) || me.gender == null || me.seeking == null) {
      return Response.json({ error: 'onboarding_incomplete' }, { status: 400 });
    }

    const limit = Number(new URL(request.url).searchParams.get('limit') ?? '10');

    // Coarse latitude band, refined by the exact haversine check below. This
    // keeps the pool query from dragging in candidates on the other side of
    // the planet only to have them scored and then discarded.
    const latDelta = me.max_distance_km / KM_PER_DEGREE_LATITUDE;
    const minLat = me.lat! - latDelta;
    const maxLat = me.lat! + latDelta;

    // u.ghosted_at IS NULL below: a ghosted user (src/lib/reports.ts) never
    // appears as a candidate to anyone, in either query -- but this is `me`'s
    // own deck request, and `me` is loaded separately via getSessionUser, so
    // this has no effect on what a ghosted caller sees when browsing their
    // own deck. Ghosting only ever hides someone *from* others, never from
    // themselves.
    const likePriorityRows = await env.DB.prepare(
      `SELECT u.*, ps.match_score FROM people_swipes ps
       JOIN users u ON u.id = ps.swiper_id
       WHERE ps.target_id = ? AND ps.direction = 'right'
         AND NOT EXISTS (SELECT 1 FROM people_swipes ps2 WHERE ps2.swiper_id = ? AND ps2.target_id = ps.swiper_id)
         AND NOT EXISTS (
           SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = ps.swiper_id) OR (b.blocker_id = ps.swiper_id AND b.blocked_id = ?)
         )
         AND u.deleted_at IS NULL AND u.ghosted_at IS NULL AND u.onboarded_at IS NOT NULL
         AND u.lat IS NOT NULL AND u.lng IS NOT NULL
         AND u.lat BETWEEN ? AND ?
         AND (${RECIPROCITY_SQL})
         ${GENRE_BLOCK_FILTER}
       ORDER BY ps.match_score DESC
       LIMIT ?`
    ).bind(me.id, me.id, me.id, me.id, minLat, maxLat, ...reciprocityParams(me), me.id, LIKE_PRIORITY_LIMIT).all<UserRow & { match_score: number }>();

    const likePriorityIds = new Set(likePriorityRows.results.map((r) => r.id));

    const poolRows = await env.DB.prepare(
      `SELECT u.* FROM users u
       WHERE u.id != ? AND u.deleted_at IS NULL AND u.ghosted_at IS NULL AND u.onboarded_at IS NOT NULL
         AND u.lat IS NOT NULL AND u.lng IS NOT NULL
         AND u.lat BETWEEN ? AND ?
         AND (${RECIPROCITY_SQL})
         AND NOT EXISTS (SELECT 1 FROM people_swipes ps WHERE ps.swiper_id = ? AND ps.target_id = u.id)
         AND NOT EXISTS (
           SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?)
         )
         ${GENRE_BLOCK_FILTER}
       LIMIT ?`
    ).bind(me.id, minLat, maxLat, ...reciprocityParams(me), me.id, me.id, me.id, me.id, POOL_LIMIT).all<UserRow>();

    const pool = poolRows.results.filter((u) => !likePriorityIds.has(u.id));

    // max_distance_km is a filter, not just a scoring weight (docs/PLAN.md):
    // someone outside the radius must not appear at all, however good their
    // music overlap is. The SQL band above is intentionally loose, so the
    // authoritative exclusion is this exact haversine check.
    const withinRadius = <T extends UserRow>(candidate: T) =>
      haversineKm(me.lat!, me.lng!, candidate.lat!, candidate.lng!) <= me.max_distance_km;

    const now = Date.now();
    // Mutual in both directions -- see isMutuallyWithinAgeRange. Previously
    // only checked "is the candidate within MY range", which let someone
    // who set a narrow range for their own safety still be shown to people
    // far outside it, as long as those people's own ranges were wide enough.
    const withinAgeRange = <T extends UserRow>(candidate: T) => isMutuallyWithinAgeRange(me, candidate, now);

    const likePriority = likePriorityRows.results.filter(withinRadius).filter(withinAgeRange);
    const inRangePool = pool.filter(withinRadius).filter(withinAgeRange);

    // Everything the scorer needs, loaded in a fixed number of queries rather
    // than 4-5 per candidate. `me`'s own profile and right-swipes in
    // particular don't change across the loop, so re-fetching them per
    // candidate was pure waste — and with a full pool it pushed the request
    // past the Workers subrequest limit outright.
    const scoringIds = [me.id, ...inRangePool.map((u) => u.id)];
    // likePriority candidates skip scoring entirely (see `selected` below),
    // so they don't need right-swipes -- but their profile is still needed
    // for the topGenres shown on their card, which scoring alone wouldn't
    // have pulled in.
    const profileIds = [...scoringIds, ...likePriority.map((u) => u.id)];
    const [profiles, rightSwipes] = await Promise.all([
      getMusicProfiles(env.DB, profileIds),
      getRightSwipedItemIdsFor(env.DB, scoringIds),
    ]);
    const meInputs = inputsFor(me.id, profiles, rightSwipes);

    const scored = inRangePool
      .map((candidate) => ({
        candidate,
        ...scoreCandidateFromInputs(me, meInputs, candidate, inputsFor(candidate.id, profiles, rightSwipes), false),
      }))
      .sort((a, b) => b.score - a.score);

    // Slice before the photo lookup so it only covers what's actually
    // returned. Distance needs no DB access at all — it's haversine over
    // lat/lng we already have — so the like-priority rows never needed the
    // full four-query scoring pass they used to make just to read distanceKm.
    const selected = [
      ...likePriority.map((c) => ({ user: c as UserRow, likedYou: true })),
      ...scored.map(({ candidate }) => ({ user: candidate, likedYou: false })),
    ].slice(0, limit);

    const [photoUrls, anthemTracks] = await Promise.all([
      primaryPhotoUrls(env.DB, selected.map((s) => s.user.id)),
      getAnthemTracksForUsers(env.DB, selected.map((s) => s.user)),
    ]);

    const candidates = selected.map(({ user, likedYou }) => ({
      id: user.id,
      displayName: user.display_name,
      bio: user.bio,
      distanceLabel: bucketedDistanceLabel(haversineKm(me.lat!, me.lng!, user.lat!, user.lng!)),
      primaryPhotoUrl: photoUrls.get(user.id) ?? null,
      likedYou,
      // Only set when the candidate picked one AND it's still in their
      // top_tracks (see pickAnthemTrack) -- absent entirely otherwise, so the
      // card's anthem chip (public/index.html) has a single falsy check.
      anthemTrack: anthemTracks.get(user.id) ?? null,
      // Already in memory from the scoring pass above (getMusicProfiles) --
      // no extra query needed. Ranked, so slicing to the top 10 here keeps
      // the payload small and matches what the card actually has room to
      // show, rather than pushing that decision onto the client.
      topGenres: (profiles.get(user.id)?.topGenres ?? []).slice(0, 10),
    }));

    return Response.json({ candidates });
  });

  // Viewable for any eligible target -- a not-yet-decided candidate or an
  // active match, not gated to matches only. The point of a music-first
  // dating app is surfacing "why you might match" (photos, bio, shared
  // artists/tracks/genres) before someone decides whether to swipe, not only
  // after a mutual right-swipe.
  router.get('/api/people/:id/profile', async (request: IRequest, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    if (!hasCompletedOnboarding(me)) {
      return Response.json({ error: 'onboarding_incomplete' }, { status: 400 });
    }

    const targetId = request.params.id;
    const isSelf = targetId === me.id;

    // ghosted_at IS NULL OR id = ?(me.id): asymmetric like everywhere else
    // ghosting is enforced -- a ghosted user must still be able to view
    // their own profile normally, only OTHERS looking them up are blocked.
    const target = await env.DB.prepare(
      'SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND onboarded_at IS NOT NULL AND (ghosted_at IS NULL OR id = ?)'
    )
      .bind(targetId, me.id)
      .first<UserRow>();
    if (!target) return new Response('Not found', { status: 404 });

    if (!isSelf && (await isBlockedEitherDirection(env.DB, me.id, targetId))) {
      return new Response('Forbidden', { status: 403 });
    }

    // Self viewing their own profile sees every photo, including one still
    // under review -- everyone else only sees approved ones, same rule as
    // GET /photos/:id and primaryPhotoUrls above (issue #36 §2).
    const photoRows = await env.DB.prepare(
      `SELECT id FROM user_photos WHERE user_id = ? ${isSelf ? '' : "AND moderation_status = 'approved'"} ORDER BY position ASC`
    )
      .bind(targetId)
      .all<{ id: string }>();

    let likedYou = false;
    let isMatch = false;
    let matchId: string | null = null;
    let distanceLabel: string | null = null;
    let overlap: MusicOverlap = { sharedArtists: [], sharedTracks: [], sharedGenres: [] };
    let recentArtists: RecentMusicItem[] = [];
    let recentTracks: RecentMusicItem[] = [];

    if (!isSelf) {
      const likedYouRow = await env.DB
        .prepare(`SELECT 1 FROM people_swipes WHERE swiper_id = ? AND target_id = ? AND direction = 'right'`)
        .bind(targetId, me.id)
        .first();

      // Passive discovery only, per getMatchNotificationDelayMs (see
      // GET /api/matches for the fuller reasoning) -- a match younger than
      // the delay simply isn't found here, so this profile badge stays
      // "not matched" until it ages past the window. Whoever already knows
      // the matchId (from the celebration modal) can still message right
      // away via GET /api/matches/:id, which isn't gated.
      const matchRow = await env.DB
        .prepare(
          `SELECT id FROM matches WHERE unmatched_at IS NULL AND created_at <= ? AND
           ((user_a_id = ? AND user_b_id = ?) OR (user_a_id = ? AND user_b_id = ?))`
        )
        .bind(Date.now() - getMatchNotificationDelayMs(env), me.id, targetId, targetId, me.id)
        .first<{ id: string }>();

      likedYou = !!likedYouRow;
      isMatch = !!matchRow;
      matchId = matchRow?.id ?? null;
      distanceLabel =
        target.lat != null && target.lng != null
          ? bucketedDistanceLabel(haversineKm(me.lat!, me.lng!, target.lat, target.lng))
          : null;
      overlap = await computeMusicOverlap(env.DB, me.id, targetId);
    } else {
      const [artists, tracks] = await Promise.all([
        recentRightSwipedItems(env.DB, me.id, 'artist', RECENT_MUSIC_LIMIT),
        recentRightSwipedItems(env.DB, me.id, 'track', RECENT_MUSIC_LIMIT),
      ]);
      recentArtists = artists;
      recentTracks = tracks;
    }

    // The target's own baseline Spotify taste -- distinct from `overlap`
    // (the intersection) and from recentArtists/recentTracks (in-app swipe
    // activity, self-only). Shown for both self and cross-view: seeing a
    // candidate's actual taste up front fits a music-first dating app.
    const { topGenres, topArtists, topTracks } = await getDisplayMusicProfile(env.DB, targetId);

    return Response.json({
      profile: {
        id: target.id,
        displayName: target.display_name,
        bio: target.bio,
        photoUrls: photoRows.results.map((r) => `/photos/${r.id}`),
        distanceLabel,
        likedYou,
        isMatch,
        matchId,
        isSelf,
        recentArtists,
        recentTracks,
        topGenres,
        topArtists,
        topTracks,
        anthemTrack: pickAnthemTrack(topTracks, target.anthem_track_id),
      },
      overlap,
    });
  });

  router.post('/api/swipe/people', async (request: Request, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    if (!hasCompletedOnboarding(me)) {
      return Response.json({ error: 'onboarding_incomplete' }, { status: 400 });
    }

    const { target_id, direction } = await request.json<{ target_id: string; direction: 'left' | 'right' }>();

    // ghosted_at IS NULL: defense in depth -- a ghosted user never appears
    // as a candidate (GET /api/candidates/people), so this only matters for
    // a stale target_id the client already had. No interaction should ever
    // register against a ghosted person, including a harmless left-swipe.
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND ghosted_at IS NULL')
      .bind(target_id)
      .first<UserRow>();
    if (!target) return Response.json({ error: 'unknown target_id' }, { status: 400 });

    if (await isBlockedEitherDirection(env.DB, me.id, target_id)) {
      return Response.json({ error: 'blocked' }, { status: 403 });
    }

    const alreadyLikedMe = await env.DB
      .prepare(`SELECT 1 FROM people_swipes WHERE swiper_id = ? AND target_id = ? AND direction = 'right'`)
      .bind(target_id, me.id)
      .first();

    const { score } = await scoreCandidate(env.DB, me, target, !!alreadyLikedMe);
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(swiper_id, target_id) DO UPDATE SET direction = excluded.direction, match_score = excluded.match_score, updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), me.id, target_id, direction, score, now, now).run();

    // Match-notification emails are NOT sent here -- they're deferred
    // (src/lib/notifications.ts's getMatchNotificationDelayMs, swept by the
    // scheduled() cron) so the person who just matched has a window to
    // unmatch before the other side is ever emailed or sees a bell badge.
    // createMatchIfMutual already inserted both participants' notification
    // rows; only the immediate email send is skipped here.
    let match = null;
    if (direction === 'right') {
      match = await createMatchIfMutual(env.DB, me.id, target_id);
    }

    return Response.json({ ok: true, matched: !!match, ...(match ? { matchId: match.matchId } : {}) });
  });

  router.get('/api/swipes/people', async (request: Request, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const direction = url.searchParams.get('direction');
    const directionFilter = direction === 'left' || direction === 'right' ? 'AND ps.direction = ?' : '';

    const rows = await env.DB.prepare(
      `SELECT ps.id, ps.target_id, ps.direction, ps.match_score, ps.created_at, u.display_name as name
       FROM people_swipes ps
       JOIN users u ON u.id = ps.target_id
       WHERE ps.swiper_id = ? ${directionFilter}
       ORDER BY ps.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...[me.id, ...(directionFilter ? [direction] : []), limit, offset]).all<any>();

    // Same filters as the page above -- see the equivalent comment on
    // GET /api/swipes/music.
    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM people_swipes ps WHERE ps.swiper_id = ? ${directionFilter}`
    )
      .bind(...[me.id, ...(directionFilter ? [direction] : [])])
      .first<{ c: number }>();

    return Response.json({ swipes: rows.results, total: totalRow?.c ?? 0 });
  });

  router.patch('/api/swipes/people/:id', async (request: IRequest, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    const { direction } = await request.json<{ direction: 'left' | 'right' }>();

    const swipe = await env.DB.prepare('SELECT target_id FROM people_swipes WHERE id = ? AND swiper_id = ?')
      .bind(request.params.id, me.id)
      .first<{ target_id: string }>();
    if (!swipe) return new Response('Not found', { status: 404 });

    await env.DB.prepare(
      `UPDATE people_swipes SET direction = ?, updated_at = ? WHERE id = ? AND swiper_id = ?`
    ).bind(direction, Date.now(), request.params.id, me.id).run();

    // Changing a past decision to right can complete a mutual like exactly
    // like a fresh right-swipe through the deck would -- this must create the
    // match too, not just record the direction.
    // See the identical comment in POST /api/swipe/people above -- the
    // match-notification email is deferred to the cron sweep, not sent here.
    let match = null;
    if (direction === 'right') {
      match = await createMatchIfMutual(env.DB, me.id, swipe.target_id);
    }

    return Response.json({ ok: true, matched: !!match, ...(match ? { matchId: match.matchId } : {}) });
  });
}
