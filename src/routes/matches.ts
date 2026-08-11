import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { notifyMessage, getMatchNotificationDelayMs } from '../lib/notifications';
import { canRecall } from '../lib/messageRecall';
import { computeMusicOverlap } from '../lib/musicOverlap';
import { isValidMessageBody } from '../lib/messageFilter';
import { hasCompleteProfile, photoCountFor } from '../lib/messagingGate';

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
      `SELECT id, sender_id, body, read_at, created_at, recalled_at FROM messages WHERE match_id = ? ORDER BY created_at ASC`
    ).bind(match.id).all<any>();

    // The row (and its real body) stays in D1 either way -- recalled_at is
    // only ever set via POST .../recall below. Nulling `body` here, rather
    // than trusting the client to hide it, is what actually keeps recalled
    // content from reaching anyone once it's set.
    return Response.json({
      messages: rows.results.map((m) => ({
        id: m.id,
        sender_id: m.sender_id,
        body: m.recalled_at ? null : m.body,
        read_at: m.read_at,
        created_at: m.created_at,
        recalledAt: m.recalled_at,
      })),
    });
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

    if (!hasCompleteProfile(user, await photoCountFor(env.DB, user.id))) {
      return Response.json({ error: 'profile_incomplete' }, { status: 403 });
    }

    const { body } = await request.json<{ body: string }>();
    if (!isValidMessageBody(body)) {
      return Response.json({ error: 'invalid_message' }, { status: 400 });
    }
    const messageId = crypto.randomUUID();
    const now = Date.now();
    const recipientId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id;

    await env.DB.prepare(
      `INSERT INTO messages (id, match_id, sender_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(messageId, match.id, user.id, body, now, now).run();

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
