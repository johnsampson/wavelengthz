import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';

/**
 * Playback telemetry for the Wavelengthz Player (the Spotify Web Playback SDK
 * path). See migrations/0022 for why this exists: the share of listens that
 * actually run long enough for Spotify to count the stream -- and pay the
 * artist -- is currently invisible, and a swipe-shaped app has an obvious
 * structural reason to suspect it's low.
 *
 * Two calls per play at most: one when playback starts (the denominator), and
 * one if it crosses the threshold (the numerator). A play abandoned early
 * simply never gets the second call, which is precisely the signal wanted --
 * so there's deliberately no "play ended" call to miss.
 *
 * Nothing here is Spotify's own royalty accounting, which this app can
 * neither see nor influence. It's a proxy for whether a product change moved
 * real listening behavior.
 */
export function registerPlayRoutes(router: RouterType) {
  router.post('/api/plays', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { spotifyTrackId, trackId, startPositionMs } = await request.json<{
      spotifyTrackId?: string;
      trackId?: string | null;
      startPositionMs?: number;
    }>();

    if (typeof spotifyTrackId !== 'string' || !spotifyTrackId.trim()) {
      return Response.json({ error: 'spotify_track_id required' }, { status: 400 });
    }

    // Clamped rather than rejected: this is best-effort telemetry, and a
    // nonsense offset from a stale client shouldn't fail a playback that
    // otherwise worked fine for the listener.
    const rawStart = Number(startPositionMs);
    const start = Number.isFinite(rawStart) && rawStart > 0 ? Math.floor(rawStart) : 0;

    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO track_plays (id, user_id, track_id, spotify_track_id, start_position_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, user.id, typeof trackId === 'string' && trackId ? trackId : null, spotifyTrackId, start, now, now)
      .run();

    return Response.json({ playId: id });
  });

  router.post('/api/plays/:id/counted', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    // Scoped to the caller's own rows, so a guessed id can't mark someone
    // else's play. Idempotent via `reached_threshold_at IS NULL`: the client
    // schedules this off a timer that a reconnect or a re-render could
    // plausibly fire twice, and the first crossing is the honest timestamp.
    const now = Date.now();
    const result = await env.DB.prepare(
      `UPDATE track_plays SET reached_threshold_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND reached_threshold_at IS NULL`
    )
      .bind(now, now, request.params.id, user.id)
      .run();

    // 200 either way -- "already counted" and "counted just now" are both
    // success from the caller's point of view, and this is fire-and-forget
    // telemetry that must never surface an error to someone listening to
    // music.
    return Response.json({ ok: true, updated: result.meta.changes > 0 });
  });
}
