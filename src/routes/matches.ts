import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { notifyMessage, getMatchNotificationDelayMs } from '../lib/notifications';
import { canRecall } from '../lib/messageRecall';
import { computeMusicOverlap } from '../lib/musicOverlap';
import { isValidMessageBody, isValidTrackCaption } from '../lib/messageFilter';
import { resolveSharedTrack, loadSharedTracks, type ShareableSpotifyTrack } from '../lib/trackSharing';
import { hasCompleteProfile, photoCountFor, artistsActedCountFor } from '../lib/messagingGate';

// A soft-deleted account must disappear from matches and messaging
// immediately (docs/PLAN.md §9), not linger until the 7-day grace period
// expires and the hard purge runs. `getSessionUser` already excludes the
// *caller* if they're deleted; these joins cover the counterpart.
//
// The ghosted_at check below is deliberately asymmetric, unlike deleted_at:
// ghosting (src/lib/reports.ts) only ever hides someone from OTHERS, never
// from themselves, so this must check whether the OTHER participant is
// ghosted, not whether either one is -- a ghosted caller still sees their
// own existing matches completely normally.
async function loadActiveMatchForParticipant(db: D1Database, matchId: string, userId: string) {
  return db
    .prepare(
      `SELECT m.* FROM matches m
       JOIN users ua ON ua.id = m.user_a_id
       JOIN users ub ON ub.id = m.user_b_id
       WHERE m.id = ? AND m.unmatched_at IS NULL AND (m.user_a_id = ? OR m.user_b_id = ?)
         AND ua.deleted_at IS NULL AND ub.deleted_at IS NULL
         AND (
           (m.user_a_id = ? AND ub.ghosted_at IS NULL) OR
           (m.user_b_id = ? AND ua.ghosted_at IS NULL)
         )`
    )
    .bind(matchId, userId, userId, userId, userId)
    .first<{ id: string; user_a_id: string; user_b_id: string; created_at: number }>();
}

export function registerMatchRoutes(router: RouterType) {
  router.get('/api/matches', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    // Passive discovery only: this list (and the isMatch badge on
    // GET /api/people/:id/profile) is exactly the "before anything happens"
    // window getMatchNotificationDelayMs exists for -- someone who
    // deliberately already knows the matchId (from the celebration modal, or
    // a message link) can still open the match detail/message it right away;
    // see src/lib/notifications.ts.
    // See loadActiveMatchForParticipant's comment on why the ghosted_at
    // check is asymmetric (checks the OTHER participant, not either one).
    const rows = await env.DB.prepare(
      `SELECT m.id, m.user_a_id, m.user_b_id, m.created_at,
              ua.display_name as user_a_display_name, ub.display_name as user_b_display_name
       FROM matches m
       JOIN users ua ON ua.id = m.user_a_id
       JOIN users ub ON ub.id = m.user_b_id
       WHERE m.unmatched_at IS NULL AND (m.user_a_id = ? OR m.user_b_id = ?)
         AND ua.deleted_at IS NULL AND ub.deleted_at IS NULL
         AND (
           (m.user_a_id = ? AND ub.ghosted_at IS NULL) OR
           (m.user_b_id = ? AND ua.ghosted_at IS NULL)
         )
         AND m.created_at <= ?
       ORDER BY m.created_at DESC`
    ).bind(user.id, user.id, user.id, user.id, Date.now() - getMatchNotificationDelayMs(env)).all<any>();

    const matches = rows.results.map((m) => ({
      id: m.id,
      otherUserId: m.user_a_id === user.id ? m.user_b_id : m.user_a_id,
      otherDisplayName: m.user_a_id === user.id ? m.user_b_display_name : m.user_a_display_name,
      createdAt: m.created_at,
    }));

    return Response.json({ matches });
  });

  router.get('/api/matches/:id', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Forbidden', { status: 403 });

    const otherUserId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id;
    const otherUser = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?')
      .bind(otherUserId)
      .first<{ display_name: string | null }>();

    const overlap = await computeMusicOverlap(env.DB, user.id, otherUserId);

    return Response.json({
      match: {
        id: match.id,
        otherUserId,
        otherDisplayName: otherUser?.display_name ?? null,
        createdAt: match.created_at,
      },
      overlap,
    });
  });

  router.post('/api/matches/:id/unmatch', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Not found', { status: 404 });

    const unmatchedAt = Date.now();
    await env.DB.prepare('UPDATE matches SET unmatched_at = ?, unmatched_by = ?, updated_at = ? WHERE id = ?')
      .bind(unmatchedAt, user.id, unmatchedAt, match.id)
      .run();

    return Response.json({ ok: true });
  });

  router.get('/api/matches/:id/messages', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Forbidden', { status: 403 });

    const rows = await env.DB.prepare(
      `SELECT id, sender_id, body, track_id, read_at, created_at, recalled_at FROM messages WHERE match_id = ? ORDER BY created_at ASC`
    ).bind(match.id).all<any>();

    // Batched, not one lookup per message -- a long thread would otherwise
    // blow past the Workers subrequest limit. Recalled messages are excluded
    // from the load entirely, since their track is never surfaced anyway.
    const tracks = await loadSharedTracks(
      env.DB,
      rows.results.filter((m) => !m.recalled_at).map((m) => m.track_id)
    );

    // The row (and its real body) stays in D1 either way -- recalled_at is
    // only ever set via POST .../recall below. Nulling `body` here, rather
    // than trusting the client to hide it, is what actually keeps recalled
    // content from reaching anyone once it's set. `track` is nulled on the
    // same condition, for the same reason: recalling a shared song has to
    // actually un-share it, not just hide the caption.
    return Response.json({
      messages: rows.results.map((m) => ({
        id: m.id,
        sender_id: m.sender_id,
        body: m.recalled_at ? null : m.body,
        track: m.recalled_at || !m.track_id ? null : tracks.get(m.track_id) ?? null,
        read_at: m.read_at,
        created_at: m.created_at,
        recalledAt: m.recalled_at,
      })),
    });
  });

  // The shared playlist: every non-recalled track ever sent in this thread,
  // oldest first. Deliberately DERIVED from messages rather than stored in
  // its own table (see migrations/0021) -- recall, unmatch, and account
  // deletion all already cascade correctly through `messages`, so a second
  // copy could only ever drift out of sync with them.
  router.get('/api/matches/:id/playlist', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Forbidden', { status: 403 });

    const rows = await env.DB.prepare(
      `SELECT track_id, sender_id, created_at FROM messages
       WHERE match_id = ? AND track_id IS NOT NULL AND recalled_at IS NULL
       ORDER BY created_at ASC`
    ).bind(match.id).all<{ track_id: string; sender_id: string; created_at: number }>();

    const tracks = await loadSharedTracks(env.DB, rows.results.map((r) => r.track_id));

    // Same song sent twice appears once, at its first appearance -- a
    // playlist with duplicates reads as a bug, and the re-send is still
    // visible in the thread itself where it carries meaning.
    const seen = new Set<string>();
    const items = [];
    for (const row of rows.results) {
      if (seen.has(row.track_id)) continue;
      const track = tracks.get(row.track_id);
      if (!track) continue; // track row deleted out from under us -- skip, don't 500
      seen.add(row.track_id);
      items.push({ ...track, sharedBy: row.sender_id, sharedAt: row.created_at });
    }

    return Response.json({ tracks: items, count: items.length });
  });

  router.post('/api/matches/:id/messages/:messageId/recall', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Forbidden', { status: 403 });

    const message = await env.DB.prepare('SELECT sender_id, created_at, recalled_at FROM messages WHERE id = ? AND match_id = ?')
      .bind(request.params.messageId, match.id)
      .first<{ sender_id: string; created_at: number; recalled_at: number | null }>();
    if (!message) return new Response('Not found', { status: 404 });

    const check = canRecall(message, user.id, Date.now());
    if (!check.ok) return Response.json({ error: check.error }, { status: check.error === 'not_sender' ? 403 : 400 });

    const recalledAt = Date.now();
    await env.DB.prepare('UPDATE messages SET recalled_at = ?, updated_at = ? WHERE id = ?')
      .bind(recalledAt, recalledAt, request.params.messageId)
      .run();
    return Response.json({ ok: true });
  });

  router.post('/api/matches/:id/messages', async (request: IRequest, env: Env, ctx: ExecutionContext) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Forbidden', { status: 403 });

    if (!hasCompleteProfile(user, await photoCountFor(env.DB, user.id), await artistsActedCountFor(env.DB, user.id))) {
      return Response.json({ error: 'profile_incomplete' }, { status: 403 });
    }

    const { body, track } = await request.json<{ body?: string; track?: ShareableSpotifyTrack }>();

    // Two shapes on one endpoint: a plain text message (body required, as
    // before), or a shared track (body optional, as a caption). Reusing this
    // route rather than adding a second one keeps the notification, push,
    // messaging-gate, and recall paths identical for both -- a shared song
    // IS a message, and every one of those behaviors should apply to it
    // unchanged.
    let trackId: string | null = null;
    if (track) {
      if (!isValidTrackCaption(body)) {
        return Response.json({ error: 'invalid_message' }, { status: 400 });
      }
      const resolved = await resolveSharedTrack(env, track, user.id);
      if ('error' in resolved) {
        // artist_unavailable is a transient Spotify failure, not bad input --
        // 503 so the client can say "try again" rather than "that's invalid".
        return Response.json({ error: resolved.error }, { status: resolved.error === 'artist_unavailable' ? 503 : 400 });
      }
      trackId = resolved.trackId;
    } else if (!isValidMessageBody(body ?? '')) {
      return Response.json({ error: 'invalid_message' }, { status: 400 });
    }

    const messageId = crypto.randomUUID();
    const now = Date.now();
    const recipientId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id;

    await env.DB.prepare(
      `INSERT INTO messages (id, match_id, sender_id, body, track_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(messageId, match.id, user.id, (body ?? '').trim(), trackId, now, now).run();

    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at, updated_at) VALUES (?, ?, 'message', ?, ?, ?)`
    ).bind(crypto.randomUUID(), recipientId, messageId, now, now).run();

    // Fire-and-forget: notifyMessage now also does per-subscription push
    // sends (ECDH keygen + HKDF + AES-GCM + ES256 sign + a real network
    // round-trip per device), so awaiting it inline would add multiple
    // serial cross-internet round-trips to the sender's request before
    // their UI unblocks -- for a recipient with several devices. waitUntil
    // lets the response return immediately while the notification still
    // gets sent; the message write and notification row are already
    // committed above either way. Same reasoning as notifyMatch for
    // isolating a failure (email-provider or push) from the caller's
    // response, but waitUntil swallows rejections silently, so the
    // .catch() here is what actually gets the failure logged.
    const notifyPromise = notifyMessage(env.DB, env, messageId, recipientId).catch((err) => {
      console.error('notifyMessage failed', err);
    });
    // Real Workers runtimes always provide ctx.waitUntil; tests pass a
    // minimal fake ExecutionContext ({} as ExecutionContext) that doesn't,
    // so this falls back to awaiting directly there -- same defensive
    // pattern as rateLimitAllows/the top-level error handler in
    // src/index.ts.
    if (typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(notifyPromise);
    } else {
      await notifyPromise;
    }

    return Response.json({ ok: true, messageId });
  });
}
