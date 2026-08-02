import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { getValidAccessToken } from '../lib/tokens';
import { fetchTopArtists, fetchTopTracks } from '../lib/spotify';

const TIME_RANGE = 'medium_term';

export function registerMeRoutes(router: RouterType) {
  router.get('/api/me', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    let profile = await env.DB.prepare('SELECT * FROM music_profiles WHERE user_id = ?')
      .bind(user.id)
      .first<any>();

    if (!profile) {
      const accessToken = await getValidAccessToken(user, env, env.DB);
      const [artists, tracks] = await Promise.all([
        fetchTopArtists(accessToken, TIME_RANGE),
        fetchTopTracks(accessToken, TIME_RANGE),
      ]);
      const genreRank = new Map<string, number>();
      for (const artist of artists) {
        for (const genre of artist.genres) {
          if (!genreRank.has(genre)) genreRank.set(genre, genreRank.size + 1);
        }
      }
      const topArtists = JSON.stringify(artists.map((a) => ({ artist_id: a.id, rank: a.rank })));
      const topTracks = JSON.stringify(tracks.map((t) => ({ track_id: t.id, rank: t.rank })));
      const topGenres = JSON.stringify([...genreRank.keys()]);
      const now = Date.now();

      await env.DB.prepare(
        `INSERT INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(user.id, topArtists, topTracks, topGenres, TIME_RANGE, now).run();

      profile = { user_id: user.id, top_artists: topArtists, top_tracks: topTracks, top_genres: topGenres, time_range: TIME_RANGE, refreshed_at: now };
    }

    const { access_token, refresh_token, ...safeUser } = user;
    return Response.json({ user: safeUser, musicProfile: profile });
  });
}
