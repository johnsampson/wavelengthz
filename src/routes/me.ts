import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { getValidAccessToken } from '../lib/tokens';
import { fetchTopArtists, fetchTopTracks } from '../lib/spotify';
import {
  messagingRequirements,
  photoCountFor,
  likedSongCountFor,
  MIN_BIO_LENGTH,
  MIN_PHOTOS,
  MIN_LIKED_SONGS,
} from '../lib/messagingGate';

const TIME_RANGE = 'medium_term';

export function registerMeRoutes(router: RouterType) {
  router.get('/api/me', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const hasSpotifyRow = await env.DB.prepare(
      `SELECT 1 FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`
    ).bind(user.id).first();
    const hasSpotify = !!hasSpotifyRow;

    let profile: any = null;

    if (hasSpotify) {
      profile = await env.DB.prepare('SELECT * FROM music_profiles WHERE user_id = ?')
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
        // name/imageUrl are stored here (not just id/rank) so profile pages can
        // display "top on Spotify" directly from this row -- no extra Spotify
        // calls or shared-catalog upsert needed just to show a name and photo.
        // Existing scoring code (src/lib/profile.ts) only ever re-maps this back
        // down to {id, rank}, so the extra fields are invisible to it.
        const topArtists = JSON.stringify(artists.map((a) => ({ artist_id: a.id, rank: a.rank, name: a.name, imageUrl: a.imageUrl })));
        const topTracks = JSON.stringify(tracks.map((t) => ({ track_id: t.id, rank: t.rank, name: t.name, imageUrl: t.imageUrl })));
        const topGenres = JSON.stringify([...genreRank.keys()]);
        const now = Date.now();

        // OR IGNORE: two concurrent first-time /api/me requests for the same user can
        // both pass the SELECT check above and both attempt this INSERT. Whichever
        // lands first wins; the loser's row is discarded instead of throwing a PK
        // violation. The freshly-fetched `profile` object below is returned either way
        // — both requests computed equally valid data from Spotify, so it doesn't
        // matter whose insert actually persisted.
        await env.DB.prepare(
          `INSERT OR IGNORE INTO music_profiles (id, user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), user.id, topArtists, topTracks, topGenres, TIME_RANGE, now, now, now).run();

        profile = {
          user_id: user.id,
          top_artists: topArtists,
          top_tracks: topTracks,
          top_genres: topGenres,
          time_range: TIME_RANGE,
          refreshed_at: now,
          created_at: now,
          updated_at: now,
        };
      }
    }

    const tokenRow = hasSpotify
      ? await env.DB.prepare(`SELECT avatar_url FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`)
          .bind(user.id)
          .first<{ avatar_url: string | null }>()
      : null;

    const safeUser = { ...user, spotify_avatar_url: tokenRow?.avatar_url ?? null };
    return Response.json({ user: safeUser, musicProfile: profile, hasSpotify });
  });

  // Backs Settings → Messaging (public/settings/messaging.html) -- a single
  // endpoint returning every messagingGate.ts requirement's live count
  // alongside its threshold and met/not-met flag, so the page can render an
  // honest checklist instead of the frontend re-deriving thresholds that
  // already live server-side. Requirement logic itself stays entirely in
  // src/lib/messagingGate.ts (also the actual enforcement point, in
  // src/routes/matches.ts and src/routes/groups.ts) -- this route only
  // reads and reports it, never a second copy of the rules.
  router.get('/api/me/messaging-status', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const [photoCount, likedSongCount] = await Promise.all([
      photoCountFor(env.DB, user.id),
      likedSongCountFor(env.DB, user.id),
    ]);
    const requirements = messagingRequirements(user, photoCount, likedSongCount);

    return Response.json({
      ready: requirements.bio && requirements.photos && requirements.likedSongs && requirements.phone,
      bio: { met: requirements.bio, length: user.bio?.trim().length ?? 0, required: MIN_BIO_LENGTH },
      photos: { met: requirements.photos, count: photoCount, required: MIN_PHOTOS },
      likedSongs: { met: requirements.likedSongs, count: likedSongCount, required: MIN_LIKED_SONGS },
      phone: { met: requirements.phone, phoneNumber: user.phone_number },
    });
  });

  // Sets or clears the caller's anthem -- the one track that plays from a tap
  // on their swipe-deck card (public/index.html) and is badged on their full
  // profile (public/profile.html). Deliberately its own tiny endpoint rather
  // than folded into POST /api/onboarding: that endpoint unconditionally
  // rewrites the whole profile-setup field set, so a one-field change there
  // means echoing back every other field just to avoid clobbering it (see
  // public/settings.js's comment on the same tradeoff).
  router.post('/api/me/anthem', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { trackId } = await request.json<{ trackId: string | null }>();

    if (trackId != null) {
      // Anthem must be one of the caller's own top tracks -- prevents setting
      // an arbitrary Spotify id here, and matches the only picker the UI ever
      // offers (profile.html's own "Top tracks on Spotify" list).
      const profileRow = await env.DB.prepare('SELECT top_tracks FROM music_profiles WHERE user_id = ?')
        .bind(user.id)
        .first<{ top_tracks: string }>();
      const topTracks: Array<{ track_id: string }> = profileRow ? JSON.parse(profileRow.top_tracks) : [];
      if (!topTracks.some((t) => t.track_id === trackId)) {
        return Response.json({ error: 'invalid_track' }, { status: 400 });
      }
    }

    await env.DB.prepare('UPDATE users SET anthem_track_id = ?, updated_at = ? WHERE id = ?')
      .bind(trackId, Date.now(), user.id)
      .run();

    return Response.json({ ok: true });
  });

  // Independent of push (POST /api/push/subscribe|unsubscribe) -- a user can
  // run both channels, either, or neither. Its own tiny endpoint for the same
  // reason as POST /api/me/anthem above: folding this into POST /api/onboarding
  // would mean Settings → Notifications (which tracks nothing else about the
  // user) has to fetch and echo back every onboarding field just to flip one
  // flag. src/lib/notifications.ts's notifyMatch/notifyMessage read this
  // column directly; there's no other gate on it.
  router.post('/api/me/email-notifications', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { enabled } = await request.json<{ enabled: boolean }>();
    if (typeof enabled !== 'boolean') {
      return Response.json({ error: 'invalid_enabled' }, { status: 400 });
    }

    await env.DB.prepare('UPDATE users SET email_notifications_enabled = ?, updated_at = ? WHERE id = ?')
      .bind(enabled ? 1 : 0, Date.now(), user.id)
      .run();

    return Response.json({ ok: true });
  });
}
