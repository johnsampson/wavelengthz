import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { genresFromRow } from '../lib/genres';
import { growArtistCatalog } from '../lib/catalogGrowth';

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
        `INSERT INTO user_genres (user_id, genre, artist_count, track_count, updated_at) VALUES (?, ?, MAX(0, ?), MAX(0, ?), ?)
         ON CONFLICT(user_id, genre) DO UPDATE SET
           artist_count = MAX(0, artist_count + ?), track_count = MAX(0, track_count + ?), updated_at = ?`
      )
      .bind(userId, genre, artistDelta, trackDelta, now, artistDelta, trackDelta, now)
      .run();
  }
}

export function registerMusicSwipeRoutes(router: RouterType) {
  router.get('/api/candidates/music', async (request: Request, env: Env) => {
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

    const queryCandidates = () =>
      env.DB.prepare(
        `SELECT id, name, ${imageColumn} as image_url FROM ${table}
         WHERE approved = 1 ${photoFilter} AND id NOT IN (
           SELECT item_id FROM music_swipes WHERE user_id = ? AND item_type = ?
         )
         ORDER BY created_at ASC
         LIMIT ?`
      ).bind(user.id, itemType, limit).all<{ id: string; name: string; image_url: string | null }>();

    let rows = await queryCandidates();

    // Catalog growth is now primarily driven by the scheduled job
    // (src/lib/catalogGrowth.ts's runCatalogGrowthJob, wired in
    // src/index.ts's scheduled()). This is only a last-resort safety net
    // for the rare case a user's pool hits zero between runs -- bounded to
    // 2 genre searches (maxGenres: 2), though each newly-inserted artist
    // also costs one track-search call, so a worst case is still several
    // sequential Spotify round-trips inline in this request. Accepted as
    // rare-path latency, same shape as the topUpArtistsForUser code this
    // replaced.
    if (itemType === 'artist') {
      const remainingRow = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM ${table}
         WHERE approved = 1 ${photoFilter} AND id NOT IN (
           SELECT item_id FROM music_swipes WHERE user_id = ? AND item_type = ?
         )`
      ).bind(user.id, itemType).first<{ c: number }>();
      const remaining = remainingRow?.c ?? 0;

      if (remaining === 0) {
        try {
          const growth = await growArtistCatalog(env, Date.now(), { maxInserted: 10, maxGenres: 2 });
          if (growth.inserted > 0) rows = await queryCandidates();
        } catch (error) {
          // A Spotify/token failure here must not turn an otherwise-successful
          // (if empty) candidates request into a 500 -- just serve what's there.
          console.error('growArtistCatalog (reactive fallback) failed', error);
        }
      }
    }

    return Response.json({
      candidates: rows.results.map((r) => ({ itemType, itemId: r.id, name: r.name, imageUrl: r.image_url })),
    });
  });

  router.post('/api/swipe/music', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { item_type, item_id, direction } = await request.json<{
      item_type: 'artist' | 'track';
      item_id: string;
      direction: 'left' | 'right';
    }>();
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
    if (direction === 'right' && previous?.direction !== 'right') {
      const genres = await genresForItem(env.DB, item_type, item_id);
      await applyGenreAffinity(env.DB, user.id, genres, item_type, 1, now);
      if (item_type === 'track') await likeArtistForTrack(env.DB, user.id, item_id, now);
    } else if (direction === 'left' && previous?.direction === 'right') {
      const genres = await genresForItem(env.DB, item_type, item_id);
      await applyGenreAffinity(env.DB, user.id, genres, item_type, -1, now);
    }

    return Response.json({ ok: true });
  });

  router.get('/api/swipes/music', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const direction = url.searchParams.get('direction');
    const directionFilter = direction === 'left' || direction === 'right' ? 'AND ms.direction = ?' : '';

    const rows = await env.DB.prepare(
      `SELECT ms.id, ms.item_type, ms.item_id, ms.direction, ms.created_at,
              COALESCE(a.name, t.name) as name,
              CASE WHEN ms.item_type = 'artist' THEN ms.item_id ELSE t.artist_id END as artist_id
       FROM music_swipes ms
       LEFT JOIN artists a ON ms.item_type = 'artist' AND a.id = ms.item_id
       LEFT JOIN tracks t ON ms.item_type = 'track' AND t.id = ms.item_id
       WHERE ms.user_id = ? ${directionFilter}
       ORDER BY ms.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...[user.id, ...(directionFilter ? [direction] : []), limit, offset]).all<any>();

    return Response.json({ swipes: rows.results });
  });

  router.patch('/api/swipes/music/:id', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { direction } = await request.json<{ direction: 'left' | 'right' }>();

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
    // affinity too, not just record the new direction.
    if (direction === 'right' && swipe.direction !== 'right') {
      const genres = await genresForItem(env.DB, swipe.item_type, swipe.item_id);
      await applyGenreAffinity(env.DB, user.id, genres, swipe.item_type, 1, now);
      if (swipe.item_type === 'track') await likeArtistForTrack(env.DB, user.id, swipe.item_id, now);
    } else if (direction === 'left' && swipe.direction === 'right') {
      const genres = await genresForItem(env.DB, swipe.item_type, swipe.item_id);
      await applyGenreAffinity(env.DB, user.id, genres, swipe.item_type, -1, now);
    }

    return Response.json({ ok: true });
  });
}
