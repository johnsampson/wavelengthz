import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { getValidAccessToken } from '../lib/tokens';
import {
  searchArtistsByName,
  fetchArtistById,
  fetchArtistTracks,
  searchTracksByArtist,
  fetchTrackById,
  getClientCredentialsToken,
} from '../lib/spotify';
import { genresFromRow } from '../lib/genres';
import { recordCatalogGenres } from '../lib/genreCatalog';
import { upsertArtist, upsertTrack } from '../lib/catalogUpsert';
import { haversineKm } from '../lib/scoring';

// Raised from 10 -- fetchArtistTracks (src/lib/spotify.ts) now fans out
// across up to 10 albums/singles in parallel rather than fetching
// sequentially, so a higher target here no longer means proportionally
// slower page loads. Actual results still vary per artist: this is a
// ceiling on what's drawn from their most recent ARTIST_ALBUMS_PAGE_SIZE
// releases, not a guarantee -- an artist with sparse releases may still
// come back with fewer.
const ARTIST_PROFILE_TRACK_LIMIT = 30;
// Ceiling on the `?limit=` query param public/artist.html's "Load more songs"
// button drives -- each bump re-fetches the whole list at a higher limit
// (fetchArtistTracks has no true offset/cursor support, see its own comment),
// so this bounds how far a single request can push Spotify fan-out rather
// than trusting an arbitrary client-supplied value. 3x the default: enough
// for a couple of "Load more" taps without approaching the Workers
// subrequest limit PR #18 was written to avoid re-hitting.
const ARTIST_PROFILE_TRACK_MAX_LIMIT = 90;

export function registerCatalogRoutes(router: RouterType) {
  router.get('/api/artists/search', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const q = new URL(request.url).searchParams.get('q') ?? '';
    const localRows = await env.DB.prepare('SELECT * FROM artists WHERE name LIKE ? LIMIT 20')
      .bind(`%${q}%`)
      .all<any>();
    // Dedup against Spotify's own ids, not our internal ones -- a live
    // Spotify search result has no internal id yet (see the `inCatalog:
    // false` shape below), only a spotify_id to compare against.
    const localSpotifyIds = new Set(localRows.results.map((r) => r.spotify_id));

    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
    const spotifyResults = q ? await searchArtistsByName(token, q, 10) : [];

    const merged = [
      ...localRows.results.map((r) => ({ id: r.id, name: r.name, genres: genresFromRow(r.genres), imageUrl: r.image_url, inCatalog: true })),
      ...spotifyResults
        .filter((a: any) => !localSpotifyIds.has(a.id))
        // Not yet in our catalog -- there's no internal id to hand out, so
        // this is the one place a raw Spotify id is unavoidable. It's
        // surfaced under its own field (not `id`) so the client can't
        // mistake it for an internal id; POST /api/artists takes it as
        // `spotifyArtistId` and returns a real internal id once added.
        .map((a: any) => ({ spotifyArtistId: a.id, name: a.name, genres: a.genres ?? [], imageUrl: a.images?.[0]?.url ?? null, inCatalog: false })),
    ];

    return Response.json({ results: merged });
  });

  router.get('/api/artists/:id', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    // The normal case: :id is our own internal artist UUID (every link the
    // app generates uses it). Falls back to treating :id as a raw Spotify
    // artist id -- checked against spotify_id first (already cataloged,
    // just reached by that id somehow), then fetched fresh from Spotify and
    // added -- preserving the "view/add a Spotify artist not yet in the
    // catalog" capability for GET /api/artists/search's `spotifyArtistId`
    // results, even though nothing in the current frontend calls it that way.
    const requestedId = request.params.id;
    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));

    // ?limit= drives "Load more songs" (public/artist.html): each tap
    // re-requests the full list at a higher limit rather than an incremental
    // page, since fetchArtistTracks has no offset/cursor to resume from.
    // Anything absent, non-numeric, or non-positive falls back to the
    // default rather than being treated as an error -- this param is
    // optional and only the frontend's own "Load more" ever sets it.
    const requestedLimit = Number(new URL(request.url).searchParams.get('limit'));
    const trackLimit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, ARTIST_PROFILE_TRACK_MAX_LIMIT)
        : ARTIST_PROFILE_TRACK_LIMIT;

    let artistRow = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind(requestedId).first<any>();
    if (!artistRow) artistRow = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind(requestedId).first<any>();
    if (!artistRow) {
      const artist = await fetchArtistById(token, requestedId);
      const upserted = await upsertArtist(env.DB, artist, 'spotify_search', user.id, Date.now());
      if (upserted.inserted) await recordCatalogGenres(env.DB, artist.genres ?? [], 'artist', Date.now());
      artistRow = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind(upserted.id).first<any>();
    }

    const artistGenres = genresFromRow(artistRow.genres);
    const topTracks = await fetchArtistTracks(token, artistRow.spotify_id, trackLimit);
    const now = Date.now();
    // Pairs each live Spotify track with its resolved internal id -- needed
    // because everything downstream (swipe direction lookup, totalLikes,
    // the response's own `id` field) operates on internal ids, while the
    // embed player (public/artist.html) still needs the real Spotify id.
    const enrichedTracks: Array<{ track: any; internalId: string }> = [];
    for (const track of topTracks) {
      const trackResult = await upsertTrack(env.DB, track, artistRow.id, 'spotify_search', user.id, now);
      if (trackResult.inserted) await recordCatalogGenres(env.DB, artistGenres, 'track', now);
      enrichedTracks.push({ track, internalId: trackResult.id });
    }

    const trackInternalIds = enrichedTracks.map((e) => e.internalId);
    const directions = new Map<string, string>();
    if (trackInternalIds.length > 0) {
      const placeholders = trackInternalIds.map(() => '?').join(', ');
      const swipeRows = await env.DB.prepare(
        `SELECT item_id, direction FROM music_swipes WHERE user_id = ? AND item_type = 'track' AND item_id IN (${placeholders})`
      )
        .bind(user.id, ...trackInternalIds)
        .all<{ item_id: string; direction: string }>();
      for (const row of swipeRows.results) directions.set(row.item_id, row.direction);
    }

    const totalLikesRow = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM music_swipes WHERE item_type = 'artist' AND item_id = ? AND direction = 'right'`
    )
      .bind(artistRow.id)
      .first<{ c: number }>();
    const totalLikes = totalLikesRow?.c ?? 0;

    // Computed in JS, not SQL: haversine isn't expressible as a plain SQL
    // comparison, and this mirrors the same pattern already used for people
    // candidates (src/routes/peopleSwipes.ts). Only meaningful when the
    // viewer has their own location set.
    let totalLikesInArea = 0;
    if (user.lat != null && user.lng != null) {
      const likerLocations = await env.DB.prepare(
        `SELECT u.lat, u.lng FROM music_swipes ms
         JOIN users u ON u.id = ms.user_id
         WHERE ms.item_type = 'artist' AND ms.item_id = ? AND ms.direction = 'right'
           AND u.lat IS NOT NULL AND u.lng IS NOT NULL AND u.deleted_at IS NULL`
      )
        .bind(artistRow.id)
        .all<{ lat: number; lng: number }>();
      totalLikesInArea = likerLocations.results.filter(
        (r) => haversineKm(user.lat!, user.lng!, r.lat, r.lng) <= user.max_distance_km
      ).length;
    }

    return Response.json({
      artist: {
        id: artistRow.id,
        name: artistRow.name,
        imageUrl: artistRow.image_url,
        genres: genresFromRow(artistRow.genres),
        totalLikes,
        totalLikesInArea,
      },
      tracks: enrichedTracks.map(({ track: t, internalId }) => ({
        id: internalId,
        // The one deliberate exception to obfuscating everywhere: the
        // Spotify embed iframe (public/artist.html) can only play a real
        // Spotify track, so it needs the actual id alongside the internal
        // one used for swiping/history/links.
        spotifyId: t.id,
        name: t.name,
        imageUrl: t.album?.images?.[0]?.url ?? null,
        previewUrl: t.preview_url ?? null,
        direction: directions.get(internalId) ?? null,
      })),
      // Heuristic, not an exact count: getting back exactly as many tracks as
      // requested means the artist likely has more beyond this cut (a higher
      // `limit` is worth trying); getting back fewer means fetchArtistTracks
      // is already exhausted (sparse discography) and asking for more
      // wouldn't turn up anything new. False once trackLimit has hit the
      // ceiling regardless, since this endpoint won't fetch any deeper.
      hasMore: enrichedTracks.length === trackLimit && trackLimit < ARTIST_PROFILE_TRACK_MAX_LIMIT,
    });
  });

  router.post('/api/artists', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { spotifyArtistId } = await request.json<{ spotifyArtistId: string }>();
    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
    const artist = await fetchArtistById(token, spotifyArtistId);

    const now = Date.now();
    const result = await upsertArtist(env.DB, artist, 'spotify_search', user.id, now);
    if (result.inserted) await recordCatalogGenres(env.DB, artist.genres ?? [], 'artist', now);

    return Response.json({ ok: true, artistId: result.id });
  });

  router.get('/api/tracks/search', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const q = url.searchParams.get('q') ?? '';
    const artistId = url.searchParams.get('artist_id');
    if (!artistId) return Response.json({ error: 'artist_id required' }, { status: 400 });

    const artist = await env.DB.prepare('SELECT name FROM artists WHERE id = ?').bind(artistId).first<{ name: string }>();
    if (!artist) return Response.json({ error: 'unknown artist_id' }, { status: 400 });

    const localRows = await env.DB.prepare('SELECT * FROM tracks WHERE artist_id = ? AND name LIKE ? LIMIT 20')
      .bind(artistId, `%${q}%`)
      .all<any>();
    // Same reasoning as GET /api/artists/search: dedup by Spotify id, and a
    // not-yet-cataloged result exposes spotifyTrackId, not a fake id.
    const localSpotifyIds = new Set(localRows.results.map((r) => r.spotify_id));

    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
    const spotifyResults = q ? await searchTracksByArtist(token, artist.name, q, 10) : [];

    const merged = [
      ...localRows.results.map((r) => ({ id: r.id, name: r.name, inCatalog: true })),
      ...spotifyResults
        .filter((t: any) => !localSpotifyIds.has(t.id))
        .map((t: any) => ({ spotifyTrackId: t.id, name: t.name, inCatalog: false })),
    ];

    return Response.json({ results: merged });
  });

  router.post('/api/tracks', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { spotifyTrackId, artistId } = await request.json<{ spotifyTrackId: string; artistId: string }>();

    const artist = await env.DB.prepare('SELECT genres FROM artists WHERE id = ?').bind(artistId).first<{ genres: string }>();
    if (!artist) return Response.json({ error: 'unknown artist_id' }, { status: 400 });

    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
    const track = await fetchTrackById(token, spotifyTrackId);

    const now = Date.now();
    const result = await upsertTrack(env.DB, track, artistId, 'spotify_search', user.id, now);
    if (result.inserted) await recordCatalogGenres(env.DB, genresFromRow(artist.genres), 'track', now);

    return Response.json({ ok: true, trackId: result.id });
  });
}
