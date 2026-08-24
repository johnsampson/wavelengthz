import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { isBlockedEitherDirection } from '../lib/blocks';
import { haversineKm } from '../lib/scoring';
import { isValidMessageBody, isValidTrackCaption } from '../lib/messageFilter';
import { resolveSharedTrack, loadSharedTracks, type ShareableSpotifyTrack } from '../lib/trackSharing';
import { canRecall } from '../lib/messageRecall';
import { hasCompleteProfile, photoCountFor, likedSongCountFor } from '../lib/messagingGate';
import { primaryPhotoUrls } from '../lib/photos';

const MAX_GROUP_NAME_LENGTH = 60;
const MAX_TOPIC_LENGTH = 100;
// Small on purpose: easier to moderate, more likely to produce real
// discussion than an open chatroom. See the plan doc's reasoning for why
// formation is user-created + browsable rather than system-auto-clustered.
const MAX_GROUP_MEMBERS = 8;
// Same coarse SQL pre-filter convention as the people-candidates pool
// (src/routes/peopleSwipes.ts) -- ~111km per degree of latitude everywhere on
// the globe, refined by an exact haversine check in JS afterward.
const KM_PER_DEGREE_LATITUDE = 111;


// How many faces a group card shows before it just reads as a count. Five is
// what fits beside the member count on a phone at the overlap below.
const GROUP_FACE_LIMIT = 5;

/**
 * Up to GROUP_FACE_LIMIT member photo URLs per group, oldest members first.
 *
 * Two queries for the whole page: one for memberships across every listed
 * group, one batched photo lookup. Slicing happens in memory rather than via
 * a per-group LIMIT precisely so this stays two queries -- a correlated
 * per-group limit in SQL would mean one round trip per group.
 */
async function faceUrlsByGroup(db: D1Database, groupIds: string[]): Promise<Map<string, string[]>> {
  const byGroup = new Map<string, string[]>();
  if (groupIds.length === 0) return byGroup;

  const placeholders = groupIds.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT group_id, user_id FROM group_members WHERE group_id IN (${placeholders}) ORDER BY joined_at ASC`
    )
    .bind(...groupIds)
    .all<{ group_id: string; user_id: string }>();

  const perGroup = new Map<string, string[]>();
  for (const row of rows.results) {
    const list = perGroup.get(row.group_id) ?? [];
    if (list.length < GROUP_FACE_LIMIT) list.push(row.user_id);
    perGroup.set(row.group_id, list);
  }

  const photos = await primaryPhotoUrls(db, [...new Set([...perGroup.values()].flat())]);
  for (const [groupId, userIds] of perGroup) {
    // Members with no approved photo are dropped rather than rendered as
    // blanks -- a row of empty circles reads as broken, and the member count
    // beside it already tells the real story.
    byGroup.set(groupId, userIds.map((id) => photos.get(id)).filter((url): url is string => !!url));
  }
  return byGroup;
}

export function registerGroupRoutes(router: RouterType) {
  router.post('/api/groups', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });
    if (user.onboarded_at == null || user.lat == null || user.lng == null) {
      return Response.json({ error: 'onboarding_incomplete' }, { status: 400 });
    }

    const { name, topic, track } = await request.json<{ name: string; topic?: string | null; track?: ShareableSpotifyTrack }>();
    if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_GROUP_NAME_LENGTH) {
      return Response.json({ error: 'invalid_name' }, { status: 400 });
    }
    if (topic != null && (typeof topic !== 'string' || topic.length > MAX_TOPIC_LENGTH)) {
      return Response.json({ error: 'invalid_topic' }, { status: 400 });
    }

    // Optional seed track (issue #127: "Start a group from a song") -- same
    // get-or-create catalog resolution POST /api/groups/:id/messages already
    // uses for a shared-in-thread track, just attached to the group itself
    // instead of a message row.
    let seedTrackId: string | null = null;
    if (track) {
      const resolved = await resolveSharedTrack(env, track, user.id);
      if ('error' in resolved) {
        return Response.json({ error: resolved.error }, { status: resolved.error === 'artist_unavailable' ? 503 : 400 });
      }
      seedTrackId = resolved.trackId;
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    // Groups are anchored at their creator's own location -- there's no
    // separate location-picker UI, and it matches how a user's own radius
    // already governs what they can discover (see GET /api/groups below).
    await env.DB.prepare(
      `INSERT INTO groups (id, name, topic, created_by, lat, lng, location_label, seed_track_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, name.trim(), topic?.trim() || null, user.id, user.lat, user.lng, user.location_label, seedTrackId, now, now).run();

    await env.DB.prepare('INSERT INTO group_members (id, group_id, user_id, joined_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), id, user.id, now, now, now)
      .run();

    return Response.json({ ok: true, groupId: id });
  });

  router.get('/api/groups', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });
    if (user.lat == null || user.lng == null) {
      return Response.json({ error: 'onboarding_incomplete' }, { status: 400 });
    }

    const latDelta = user.max_distance_km / KM_PER_DEGREE_LATITUDE;
    const minLat = user.lat - latDelta;
    const maxLat = user.lat + latDelta;

    // A group the caller has already joined always stays listed, even if it's
    // outside their current radius (they may have joined via a direct link,
    // or moved since) -- otherwise it would silently vanish from their own
    // list with no way back in except that same link.
    const rows = await env.DB.prepare(
      `SELECT g.id, g.name, g.topic, g.location_label, g.lat, g.lng, g.created_at,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) as member_count,
              EXISTS(SELECT 1 FROM group_members gm2 WHERE gm2.group_id = g.id AND gm2.user_id = ?) as is_member
       FROM groups g
       WHERE g.lat BETWEEN ? AND ?
          OR EXISTS(SELECT 1 FROM group_members gm3 WHERE gm3.group_id = g.id AND gm3.user_id = ?)`
    ).bind(user.id, minLat, maxLat, user.id).all<any>();

    // The SQL band above is intentionally loose (see peopleSwipes.ts) -- this
    // exact haversine check is the authoritative radius filter, except for
    // groups already joined (see above).
    const visible = rows.results.filter(
      (g) => g.is_member || haversineKm(user.lat!, user.lng!, g.lat, g.lng) <= user.max_distance_km
    );

    // Faces for the group cards (issue #2). Two queries total regardless of
    // how many groups are listed -- one for the memberships, one batched
    // photo lookup -- rather than a per-group round trip, same reasoning as
    // primaryPhotoUrls' own batching.
    const memberFaces = await faceUrlsByGroup(env.DB, visible.map((g) => g.id));

    const groups = visible.map((g) => ({
      id: g.id,
      name: g.name,
      topic: g.topic,
      locationLabel: g.location_label,
      memberCount: g.member_count,
      isMember: !!g.is_member,
      createdAt: g.created_at,
      memberFaces: memberFaces.get(g.id) ?? [],
    }));

    return Response.json({ groups });
  });

  router.get('/api/groups/:id', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const group = await env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(request.params.id).first<any>();
    if (!group) return new Response('Not found', { status: 404 });

    const membership = await env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(group.id, user.id)
      .first();
    if (!membership) return new Response('Forbidden', { status: 403 });

    const members = await env.DB.prepare(
      `SELECT u.id, u.display_name FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY gm.joined_at ASC`
    ).bind(group.id).all<{ id: string; display_name: string | null }>();

    const photos = await primaryPhotoUrls(env.DB, members.results.map((m) => m.id));
    // At most one lookup, keyed the same way GET /api/groups/:id/messages
    // already resolves message.track_id -- same shape, so group.html's
    // pinned seed-track card can reuse trackPicker.js's playSharedTrack()
    // unchanged.
    const seedTrack = group.seed_track_id ? (await loadSharedTracks(env.DB, [group.seed_track_id])).get(group.seed_track_id) ?? null : null;

    return Response.json({
      group: {
        id: group.id,
        name: group.name,
        topic: group.topic,
        locationLabel: group.location_label,
        seedTrack,
        members: members.results.map((m) => ({
          id: m.id,
          displayName: m.display_name,
          // null is an ordinary case, not a failure: no photo uploaded yet,
          // or a position-0 photo that moderation hasn't approved. The client
          // falls back to an initial.
          photoUrl: photos.get(m.id) ?? null,
        })),
      },
    });
  });

  router.post('/api/groups/:id/join', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const groupId = request.params.id;
    const group = await env.DB.prepare('SELECT id FROM groups WHERE id = ?').bind(groupId).first<{ id: string }>();
    if (!group) return new Response('Not found', { status: 404 });

    const already = await env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, user.id)
      .first();
    if (already) return Response.json({ ok: true });

    const memberRows = await env.DB.prepare('SELECT user_id FROM group_members WHERE group_id = ?')
      .bind(groupId)
      .all<{ user_id: string }>();
    if (memberRows.results.length >= MAX_GROUP_MEMBERS) {
      return Response.json({ error: 'group_full' }, { status: 403 });
    }

    // A block in either direction with ANY existing member keeps a group a
    // safe space -- rejecting the join outright is simpler (and safer) than
    // trying to selectively hide messages between blocked pairs within a
    // shared group.
    for (const m of memberRows.results) {
      if (await isBlockedEitherDirection(env.DB, user.id, m.user_id)) {
        return Response.json({ error: 'blocked' }, { status: 403 });
      }
    }

    const joinedAt = Date.now();
    await env.DB.prepare('INSERT INTO group_members (id, group_id, user_id, joined_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), groupId, user.id, joinedAt, joinedAt, joinedAt)
      .run();

    return Response.json({ ok: true });
  });

  router.post('/api/groups/:id/leave', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    await env.DB.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(request.params.id, user.id)
      .run();

    return Response.json({ ok: true });
  });

  router.get('/api/groups/:id/messages', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const membership = await env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(request.params.id, user.id)
      .first();
    if (!membership) return new Response('Forbidden', { status: 403 });

    const rows = await env.DB.prepare(
      `SELECT id, sender_id, body, track_id, created_at, recalled_at FROM group_messages WHERE group_id = ? ORDER BY created_at ASC`
    ).bind(request.params.id).all<any>();

    const tracks = await loadSharedTracks(
      env.DB,
      rows.results.filter((m) => !m.recalled_at).map((m) => m.track_id)
    );

    // Same reasoning as GET /api/matches/:id/messages: the row (and its real
    // body) stays in D1 regardless -- nulling `body` (and `track`) here is
    // what actually keeps recalled content from reaching other members.
    return Response.json({
      messages: rows.results.map((m) => ({
        id: m.id,
        sender_id: m.sender_id,
        body: m.recalled_at ? null : m.body,
        track: m.recalled_at || !m.track_id ? null : tracks.get(m.track_id) ?? null,
        created_at: m.created_at,
        recalledAt: m.recalled_at,
      })),
    });
  });

  // A group's collective crate -- every non-recalled track any member has
  // shared. Same derived-not-stored design as the 1:1 playlist; see
  // GET /api/matches/:id/playlist and migrations/0021.
  router.get('/api/groups/:id/playlist', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const membership = await env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(request.params.id, user.id)
      .first();
    if (!membership) return new Response('Forbidden', { status: 403 });

    const rows = await env.DB.prepare(
      `SELECT track_id, sender_id, created_at FROM group_messages
       WHERE group_id = ? AND track_id IS NOT NULL AND recalled_at IS NULL
       ORDER BY created_at ASC`
    ).bind(request.params.id).all<{ track_id: string; sender_id: string; created_at: number }>();

    const tracks = await loadSharedTracks(env.DB, rows.results.map((r) => r.track_id));

    const seen = new Set<string>();
    const items = [];
    for (const row of rows.results) {
      if (seen.has(row.track_id)) continue;
      const track = tracks.get(row.track_id);
      if (!track) continue;
      seen.add(row.track_id);
      items.push({ ...track, sharedBy: row.sender_id, sharedAt: row.created_at });
    }

    return Response.json({ tracks: items, count: items.length });
  });

  router.post('/api/groups/:id/messages/:messageId/recall', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const groupId = request.params.id;
    const membership = await env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, user.id)
      .first();
    if (!membership) return new Response('Forbidden', { status: 403 });

    const message = await env.DB.prepare('SELECT sender_id, created_at, recalled_at FROM group_messages WHERE id = ? AND group_id = ?')
      .bind(request.params.messageId, groupId)
      .first<{ sender_id: string; created_at: number; recalled_at: number | null }>();
    if (!message) return new Response('Not found', { status: 404 });

    const check = canRecall(message, user.id, Date.now());
    if (!check.ok) return Response.json({ error: check.error }, { status: check.error === 'not_sender' ? 403 : 400 });

    const recalledAt = Date.now();
    await env.DB.prepare('UPDATE group_messages SET recalled_at = ?, updated_at = ? WHERE id = ?')
      .bind(recalledAt, recalledAt, request.params.messageId)
      .run();
    return Response.json({ ok: true });
  });

  router.post('/api/groups/:id/messages', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const groupId = request.params.id;
    const membership = await env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, user.id)
      .first();
    if (!membership) return new Response('Forbidden', { status: 403 });

    if (!hasCompleteProfile(user, await photoCountFor(env.DB, user.id), await likedSongCountFor(env.DB, user.id))) {
      return Response.json({ error: 'profile_incomplete' }, { status: 403 });
    }

    const { body, track } = await request.json<{ body?: string; track?: ShareableSpotifyTrack }>();

    // Same two-shapes-one-endpoint split as POST /api/matches/:id/messages.
    let trackId: string | null = null;
    if (track) {
      if (!isValidTrackCaption(body)) {
        return Response.json({ error: 'invalid_message' }, { status: 400 });
      }
      const resolved = await resolveSharedTrack(env, track, user.id);
      if ('error' in resolved) {
        return Response.json({ error: resolved.error }, { status: resolved.error === 'artist_unavailable' ? 503 : 400 });
      }
      trackId = resolved.trackId;
    } else if (!isValidMessageBody(body ?? '')) {
      return Response.json({ error: 'invalid_message' }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare('INSERT INTO group_messages (id, group_id, sender_id, body, track_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, groupId, user.id, (body ?? '').trim(), trackId, now, now)
      .run();

    return Response.json({ ok: true, messageId: id });
  });
}
