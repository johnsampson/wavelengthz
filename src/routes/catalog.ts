import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { getValidAccessToken } from '../lib/tokens';
import { searchArtistsByName, fetchArtistById, searchTracksByArtist, fetchTrackById, getClientCredentialsToken } from '../lib/spotify';

export function registerCatalogRoutes(router: RouterType) {
  router.get('/api/artists/search', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const q = new URL(request.url).searchParams.get('q') ?? '';
    const localRows = await env.DB.prepare('SELECT * FROM artists WHERE name LIKE ? LIMIT 20')
      .bind(`%${q}%`)
      .all<any>();
    const localIds = new Set(localRows.results.map((r) => r.id));

    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
    const spotifyResults = q ? await searchArtistsByName(token, q, 10) : [];

    const merged = [
      ...localRows.results.map((r) => ({ id: r.id, name: r.name, genres: JSON.parse(r.genres), inCatalog: true })),
      ...spotifyResults
        .filter((a: any) => !localIds.has(a.id))
        .map((a: any) => ({ id: a.id, name: a.name, genres: a.genres ?? [], inCatalog: false })),
    ];

    return Response.json({ results: merged });
  });

  router.post('/api/artists', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { spotifyArtistId } = await request.json<{ spotifyArtistId: string }>();
    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
    const artist = await fetchArtistById(token, spotifyArtistId);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO artists (id, name, genres, image_url, popularity, source, added_by_user_id, approved, created_at)
       VALUES (?, ?, ?, ?, ?, 'spotify_search', ?, 1, ?)`
    ).bind(artist.id, artist.name, JSON.stringify(artist.genres ?? []), artist.images?.[0]?.url ?? null, artist.popularity ?? null, user.id, Date.now()).run();

    return Response.json({ ok: true, artistId: artist.id });
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
    const localIds = new Set(localRows.results.map((r) => r.id));

    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
    const spotifyResults = q ? await searchTracksByArtist(token, artist.name, q, 10) : [];

    const merged = [
      ...localRows.results.map((r) => ({ id: r.id, name: r.name, inCatalog: true })),
      ...spotifyResults.filter((t: any) => !localIds.has(t.id)).map((t: any) => ({ id: t.id, name: t.name, inCatalog: false })),
    ];

    return Response.json({ results: merged });
  });

  router.post('/api/tracks', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { spotifyTrackId, artistId } = await request.json<{ spotifyTrackId: string; artistId: string }>();
    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
    const track = await fetchTrackById(token, spotifyTrackId);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO tracks (id, name, artist_id, album_image_url, preview_url, source, added_by_user_id, approved, created_at)
       VALUES (?, ?, ?, ?, ?, 'spotify_search', ?, 1, ?)`
    ).bind(track.id, track.name, artistId, track.album?.images?.[0]?.url ?? null, track.preview_url ?? null, user.id, Date.now()).run();

    return Response.json({ ok: true, trackId: track.id });
  });
}
