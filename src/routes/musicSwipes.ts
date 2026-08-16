import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { genresFromRow } from '../lib/genres';
import { topUpArtistsForUser } from '../lib/artistTopUp';

async function genresForItem(db: D1Database, itemType: 'artist' | 'track', itemId: string): Promise<string[]> {
  const row =
    itemType === 'artist'
      ? await db.prepare('SELECT genres FROM artists WHERE id = ?').bind(itemId).first<{ genres: string }>()
      : await db
          .prepare('SELECT a.genres as genres FROM tracks t JOIN artists a ON a.id = t.artist_id WHERE t.id = ?')
          .bind(itemId)
          .first<{ genres: string }>();
  if (!row) return [];
  return genresFromRow(row.genres);
}

// Liking a song is treated as liking its artist too -- one-directional only:
// passing on (or un-liking) a track never un-likes the artist, since a single
// track pass doesn't retract a broader endorsement (other tracks by them, or
// an independent artist-level like, may still stand). Idempotent: a no-op
// once the artist is already liked, so re-liking multiple tracks by the same
// artist never double-counts genre affinity for the artist.
async function likeArtistForTrack(db: D1Database, userId: string, trackId: string, now: number): Promise<void> {
  const track = await db.prepare('SELECT artist_id FROM tracks WHERE id = ?').bind(trackId).first<{ artist_id: string }>();
  if (!track) return;

  const existing = await db
    .prepare(`SELECT direction FROM music_swipes WHERE user_id = ? AND item_type = 'artist' AND item_id = ?`)
    .bind(userId, track.artist_id)
    .first<{ direction: string }>();
  if (existing?.direction === 'right') return;

  await db.prepare(
    `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at)
     VALUES (?, ?, 'artist', ?, 'right', ?, ?)
     ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET direction = 'right', updated_at = excluded.updated_at`
  ).bind(crypto.randomUUID(), userId, track.artist_id, now, now).run();

  const artistGenres = await genresForItem(db, 'artist', track.artist_id);
  await applyGenreAffinity(db, userId, artistGenres, 'artist', 1, now);
}

async function applyGenreAffinity(
  db: D1Database,
  userId: string,
  genres: string[],
  itemType: 'artist' | 'track',
  delta: 1 | -1,
  now: number
): Promise<void> {
  const artistDelta = itemType === 'artist' ? delta : 0;
  const trackDelta = itemType === 'track' ? delta : 0;
  for (const genre of genres) {
    await db
      .prepare(
        `INSERT INTO user_genres (id, user_id, genre, artist_count, track_count, created_at, updated_at) VALUES (?, ?, ?, MAX(0, ?), MAX(0, ?), ?, ?)
         ON CONFLICT(user_id, genre) DO UPDATE SET
           artist_count = MAX(0, artist_count + ?), track_count = MAX(0, track_count + ?), updated_at = ?`
      )
      .bind(crypto.randomUUID(), userId, genre, artistDelta, trackDelta, now, now, artistDelta, trackDelta, now)
      .run();
  }
}

// Once a user's passes on a single genre cross this, the client shows a
// "hide this genre?" prompt (see the crossedGenre field on POST
// /api/swipe/music and PATCH /api/swipes/music/:id below). Not split by
// item type (artist vs. track) -- artist-level swiping is the primary mode
// (see the product spec's §4.1), and the ask was simply "10 or more," not a
// per-type nuance.
const GENRE_PASS_THRESHOLD = 10;

// Symmetric to applyGenreAffinity, but for pass_count (left-swipes) instead
// of artist_count/track_count (right-swipes/likes) -- same table, same
// transition-based increment/decrement discipline. Returns the first genre
// that just crossed GENRE_PASS_THRESHOLD on this call (delta > 0 only;
// undoing a pass never re-triggers the prompt), or null if none did.
async function applyGenrePass(db: D1Database, userId: string, genres: string[], delta: 1 | -1, now: number): Promise<string | null> {
  let crossedGenre: string | null = null;
  for (const genre of genres) {
    await db
      .prepare(
        `INSERT INTO user_genres (id, user_id, genre, pass_count, created_at, updated_at) VALUES (?, ?, ?, MAX(0, ?), ?, ?)
         ON CONFLICT(user_id, genre) DO UPDATE SET pass_count = MAX(0, pass_count + ?), updated_at = ?`
      )
      .bind(crypto.randomUUID(), userId, genre, delta, now, now, delta, now)
      .run();

    if (delta > 0 && crossedGenre === null) {
      const row = await db.prepare('SELECT pass_count FROM user_genres WHERE user_id = ? AND genre = ?').bind(userId, genre).first<{ pass_count: number }>();
      if (row?.pass_count === GENRE_PASS_THRESHOLD) crossedGenre = genre;
    }
  }
  return crossedGenre;
}

// Once fewer than this many unswiped artists remain, kick off a background
// top-up (see below) instead of waiting for the pool to hit exactly zero.
const LOW_ARTIST_POOL_THRESHOLD = 15;

// 'skip' (issue: "no reason to pass if you don't know who they are") defers
// a decision on an artist you don't recognize rather than forcing a
// like/pass verdict -- it still counts as swiped (migrations/0019) so the
// deck moves on, but doesn't touch genre affinity or pass tracking either
// way, and is revisited later through History's existing "Change" control
// rather than a second UI for un-skipping.
const VALID_DIRECTIONS = new Set(['left', 'right', 'skip']);

export function registerMusicSwipeRoutes(router: RouterType) {
  router.get('/api/candidates/music', async (request: Request, env: Env, ctx: ExecutionContext) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const itemType = url.searchParams.get('item_type') ?? 'artist';
    const limit = Number(url.searchParams.get('limit') ?? '10');
    const table = itemType === 'track' ? 'tracks' : 'artists';
    const imageColumn = itemType === 'track' ? 'album_image_url' : 'image_url';
    // Artist candidates with no photo make for a broken-looking swipe card,
    // so they're excluded outright. Tracks aren't included in this ask --
    // their album art is nearly always present since it comes from the
    // release itself rather than an artist's own uploaded image.
    const photoFilter = itemType === 'artist' ? `AND ${imageColumn} IS NOT NULL AND ${imageColumn} != ''` : '';
    // Tracks don't carry their own genres column (see genresForItem above) --
    // reach through to the parent artist's for the same check.
    const genresExpr = itemType === 'track' ? '(SELECT genres FROM artists WHERE artists.id = tracks.artist_id)' : 'genres';
    // Excludes any candidate carrying a genre the user has explicitly
    // blocked (src/routes/genreBlocks.ts). json_each walks the genres JSON
    // object's keys -- confirmed working against D1's SQLite build, same
    // shape genresFromRow already assumes elsewhere in this codebase.
    const blockedGenreFilter = `AND NOT EXISTS (
      SELECT 1 FROM json_each(${genresExpr}) je
      WHERE je.key IN (SELECT genre FROM user_blocked_genres WHERE user_id = ?)
    )`;

    // Artist candidates only: a representative track already in our own
    // catalog for this artist, if one exists, so the deck can offer a
    // "play a song" chip without a live per-candidate fetch just to
    // discover whether one's available -- batched into this same query,
    // same reasoning as every other batched-not-per-row lookup in this
    // codebase. Picked by insertion order (rowid), matching the "oldest
    // inserted = earliest release" convention GET /api/artists/:id's own
    // track ordering already uses. The scalar subquery as the JOIN key
    // (rather than a plain `rt.artist_id = artists.id` join) is required to
    // keep exactly one row per artist candidate -- a plain join would
    // multiply rows for any artist with more than one cataloged track,
    // silently breaking this query's `LIMIT`. `artists`/`tracks` share
    // several column names (id, name, approved, created_at, spotify_id) --
    // every reference below is qualified with `${table}.`/`rt.` accordingly
    // to avoid "ambiguous column name" once this join is present.
    const trackPreviewJoin =
      itemType === 'artist'
        ? `LEFT JOIN tracks rt ON rt.id = (SELECT id FROM tracks WHERE artist_id = ${table}.id ORDER BY rowid ASC LIMIT 1)`
        : '';
    const trackPreviewSelect =
      itemType === 'artist' ? `, rt.id as track_id, rt.spotify_id as track_spotify_id, rt.name as track_name, rt.album_image_url as track_image_url` : '';

    const queryCandidates = () =>
      env.DB.prepare(
        `SELECT ${table}.id, ${table}.name, ${table}.${imageColumn} as image_url${trackPreviewSelect} FROM ${table}
         ${trackPreviewJoin}
         WHERE ${table}.approved = 1 ${photoFilter} AND ${table}.id NOT IN (
           SELECT item_id FROM music_swipes WHERE user_id = ? AND item_type = ?
         )
         ${blockedGenreFilter}
         ORDER BY ${table}.created_at ASC
         LIMIT ?`
      ).bind(user.id, itemType, user.id, limit).all<{
        id: string;
        name: string;
        image_url: string | null;
        track_id?: string | null;
        track_spotify_id?: string | null;
        track_name?: string | null;
        track_image_url?: string | null;
      }>();

    let rows = await queryCandidates();

    // Never let a user permanently hit "no more candidates" in music mode.
    // Tracks aren't included in either path below: track candidates come
    // from artists already in the catalog, so topping up artists indirectly
    // grows track candidates too on a later run.
    if (itemType === 'artist') {
      const remainingRow = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM ${table}
         WHERE approved = 1 ${photoFilter} AND id NOT IN (
           SELECT item_id FROM music_swipes WHERE user_id = ? AND item_type = ?
         )
         ${blockedGenreFilter}`
      ).bind(user.id, itemType, user.id).first<{ c: number }>();
      const remaining = remainingRow?.c ?? 0;

      if (remaining === 0) {
        // Genuinely out right now -- top up synchronously so THIS request
        // doesn't come back empty (matters the very first time a user's pool
        // runs dry, before the background path below ever gets a chance to
        // run ahead of it).
        try {
          const inserted = await topUpArtistsForUser(env, user);
          if (inserted > 0) rows = await queryCandidates();
        } catch (error) {
          // A Spotify/token failure here must not turn an otherwise-successful
          // (if empty) candidates request into a 500 -- just serve what's there.
          console.error('topUpArtistsForUser failed', error);
        }
      } else if (remaining < LOW_ARTIST_POOL_THRESHOLD) {
        // Below the threshold but not empty yet: top up in the BACKGROUND via
        // ctx.waitUntil rather than blocking this response. The deck only
        // re-fetches once its local queue is fully drained (public/index.html's
        // decide()), so this gives the Spotify round-trip the user's remaining
        // swipe-throughs' worth of wall-clock time to finish -- hiding the
        // latency the synchronous-only version made visible right when
        // someone hit their last candidate.
        ctx.waitUntil(
          topUpArtistsForUser(env, user).catch((error) => console.error('background topUpArtistsForUser failed', error))
        );
      }
    }

    return Response.json({
      candidates: rows.results.map((r) => ({
        itemType,
        itemId: r.id,
        name: r.name,
        imageUrl: r.image_url,
        // Only ever set for artist candidates (see trackPreviewSelect
        // above) -- catalog-backed (spotifyId + our own internal id), so
        // liking it via the player bar cascades to likeArtistForTrack's
        // artist-like/genre-affinity bonus, unlike a raw Spotify-sourced
        // track id.
        track: r.track_id ? { id: r.track_id, spotifyId: r.track_spotify_id, name: r.track_name, imageUrl: r.track_image_url } : null,
      })),
    });
  });

  router.post('/api/swipe/music', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { item_type, item_id, direction } = await request.json<{
      item_type: 'artist' | 'track';
      item_id: string;
      direction: 'left' | 'right' | 'skip';
    }>();
    if (!VALID_DIRECTIONS.has(direction)) {
      return Response.json({ error: 'invalid_direction' }, { status: 400 });
    }
    const now = Date.now();

    const previous = await env.DB.prepare(
      `SELECT direction FROM music_swipes WHERE user_id = ? AND item_type = ? AND item_id = ?`
    ).bind(user.id, item_type, item_id).first<{ direction: string }>();

    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET direction = excluded.direction, updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), user.id, item_type, item_id, direction, now, now).run();

    // Genre affinity tracks *currently* right-swiped items, so it only moves
    // on an actual transition -- a repeat right-swipe of an already-liked
    // item must not double-count, and a left-swipe only decrements genres
    // that were counted from a prior right-swipe in the first place.
    // Pass tracking (genre_pass_count) is the exact mirror for left-swipes,
    // so the same transition-based discipline applies to it too. 'skip'
    // touches neither on its own -- it's not a like or a pass -- but the
    // third branch below still has to undo a prior 'right's affinity if a
    // swipe is ever changed away from it via skip specifically (not
    // reachable from today's UI, which only offers skip on a fresh,
    // never-swiped candidate, but the API shouldn't depend on that holding).
    let crossedGenre: string | null = null;
    if (direction === 'right' && previous?.direction !== 'right') {
      const genres = await genresForItem(env.DB, item_type, item_id);
      await applyGenreAffinity(env.DB, user.id, genres, item_type, 1, now);
      if (item_type === 'track') await likeArtistForTrack(env.DB, user.id, item_id, now);
      if (previous?.direction === 'left') await applyGenrePass(env.DB, user.id, genres, -1, now);
    } else if (direction === 'left' && previous?.direction !== 'left') {
      const genres = await genresForItem(env.DB, item_type, item_id);
      if (previous?.direction === 'right') await applyGenreAffinity(env.DB, user.id, genres, item_type, -1, now);
      crossedGenre = await applyGenrePass(env.DB, user.id, genres, 1, now);
    } else if (direction === 'skip' && previous?.direction === 'right') {
      const genres = await genresForItem(env.DB, item_type, item_id);
      await applyGenreAffinity(env.DB, user.id, genres, item_type, -1, now);
    }

    return Response.json({ ok: true, crossedGenre });
  });

  router.get('/api/swipes/music', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const direction = url.searchParams.get('direction');
    const directionFilter = direction === 'left' || direction === 'right' ? 'AND ms.direction = ?' : '';
    // Optional: History (public/history.js) always passes this now, splitting
    // what used to be one combined "Music" tab into separate Artists/Tracks
    // tabs. Left optional (not required) so an old cached client, or any
    // future caller that genuinely wants both types together, still works.
    const itemType = url.searchParams.get('item_type');
    const itemTypeFilter = itemType === 'artist' || itemType === 'track' ? 'AND ms.item_type = ?' : '';

    const rows = await env.DB.prepare(
      `SELECT ms.id, ms.item_type, ms.item_id, ms.direction, ms.created_at,
              COALESCE(a.name, t.name) as name,
              CASE WHEN ms.item_type = 'artist' THEN ms.item_id ELSE t.artist_id END as artist_id
       FROM music_swipes ms
       LEFT JOIN artists a ON ms.item_type = 'artist' AND a.id = ms.item_id
       LEFT JOIN tracks t ON ms.item_type = 'track' AND t.id = ms.item_id
       WHERE ms.user_id = ? ${directionFilter} ${itemTypeFilter}
       ORDER BY ms.created_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...[user.id, ...(directionFilter ? [direction] : []), ...(itemTypeFilter ? [itemType] : []), limit, offset])
      .all<any>();

    return Response.json({ swipes: rows.results });
  });

  router.patch('/api/swipes/music/:id', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { direction } = await request.json<{ direction: 'left' | 'right' | 'skip' }>();
    if (!VALID_DIRECTIONS.has(direction)) {
      return Response.json({ error: 'invalid_direction' }, { status: 400 });
    }

    const swipe = await env.DB.prepare('SELECT item_type, item_id, direction FROM music_swipes WHERE id = ? AND user_id = ?')
      .bind(request.params.id, user.id)
      .first<{ item_type: 'artist' | 'track'; item_id: string; direction: string }>();
    if (!swipe) return new Response('Not found', { status: 404 });

    const now = Date.now();
    await env.DB.prepare(
      `UPDATE music_swipes SET direction = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    ).bind(direction, now, request.params.id, user.id).run();

    // Same transition-based logic as the fresh-swipe POST handler -- changing
    // a past decision via the History "Change" toggle must move genre
    // affinity (and pass tracking) too, not just record the new direction.
    // The skip branch below is defensive for the same reason as the
    // fresh-swipe POST handler's: public/history.js's toggle() only ever
    // sends 'left' or 'right' (never 'skip'), so a skip row's first "Change"
    // tap turns it into a real like, and there's no UI path back to 'skip'
    // once that happens -- but this endpoint shouldn't rely on that holding.
    let crossedGenre: string | null = null;
    if (direction === 'right' && swipe.direction !== 'right') {
      const genres = await genresForItem(env.DB, swipe.item_type, swipe.item_id);
      await applyGenreAffinity(env.DB, user.id, genres, swipe.item_type, 1, now);
      if (swipe.item_type === 'track') await likeArtistForTrack(env.DB, user.id, swipe.item_id, now);
      if (swipe.direction === 'left') await applyGenrePass(env.DB, user.id, genres, -1, now);
    } else if (direction === 'left' && swipe.direction !== 'left') {
      const genres = await genresForItem(env.DB, swipe.item_type, swipe.item_id);
      if (swipe.direction === 'right') await applyGenreAffinity(env.DB, user.id, genres, swipe.item_type, -1, now);
      crossedGenre = await applyGenrePass(env.DB, user.id, genres, 1, now);
    } else if (direction === 'skip' && swipe.direction === 'right') {
      const genres = await genresForItem(env.DB, swipe.item_type, swipe.item_id);
      await applyGenreAffinity(env.DB, user.id, genres, swipe.item_type, -1, now);
    }

    return Response.json({ ok: true, crossedGenre });
  });
}
