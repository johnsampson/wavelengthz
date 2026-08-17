import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import { MIN_PHOTOS, MIN_LIKED_SONGS } from '../../src/lib/messagingGate';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function makeUser(id: string, lat = 30.27, lng = -97.74, maxDistanceKm = 80) {
  await insertTestUser(env.DB, {
    id,
    spotifyId: `sp-${id}`,
    lat,
    lng,
    maxDistanceKm,
    onboardedAt: 1000,
    // Message-eligible by default (issue #36's profile-completeness gate,
    // src/lib/messagingGate.ts) -- this file's tests are about group
    // membership/messages, not about the gate itself.
    bio: 'A bio long enough to pass the profile-completeness gate.',
    phoneVerifiedAt: 1000,
    accessToken: 'a',
    refreshToken: 'r',
    tokenExpiresAt: 9999999999999,
    createdAt: 1000,
    updatedAt: 1000,
  });
  for (let i = 0; i < MIN_PHOTOS; i++) {
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at, updated_at) VALUES (?, ?, ?, ?, 1000, 1000)`
    )
      .bind(`photo-${id}-${i}`, id, `users/${id}/photo${i}.jpg`, i)
      .run();
  }
  for (let i = 0; i < MIN_LIKED_SONGS; i++) {
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES (?, ?, 'track', ?, 'right', 1000, 1000)`
    )
      .bind(`liked-${id}-${i}`, id, `track-${id}-${i}`)
      .run();
  }
}

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  // Children before parents -- D1 enforces FK constraints.
  await env.DB.exec(
    'DELETE FROM group_messages; DELETE FROM group_members; DELETE FROM groups; DELETE FROM blocks; DELETE FROM user_photos; DELETE FROM music_swipes; DELETE FROM user_genres; DELETE FROM genres; DELETE FROM tracks; DELETE FROM artists; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM sessions; DELETE FROM users;'
  );
  await makeUser('u1');
});

describe('POST /api/groups', () => {
  it('creates a group anchored at the creator\'s location and auto-joins them', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Indie Fans', topic: 'indie rock' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.groupId).toBeTruthy();

    const group = await env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(body.groupId).first<any>();
    expect(group.name).toBe('Indie Fans');
    expect(group.topic).toBe('indie rock');
    expect(group.lat).toBe(30.27);
    expect(group.lng).toBe(-97.74);
    expect(group.updated_at).not.toBeNull();

    const member = await env.DB.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').bind(body.groupId, 'u1').first<any>();
    expect(member).toBeTruthy();
    // group_members didn't have its own id before this schema cleanup --
    // it was keyed by (group_id, user_id) alone.
    expect(member.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(member.created_at).not.toBeNull();
    expect(member.updated_at).not.toBeNull();
  });

  it('rejects a blank name', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_name');
  });

  it('rejects a name over the length cap', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'a'.repeat(61) }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
  });

  it('rejects when the caller has not completed onboarding', async () => {
    await insertTestUser(env.DB, {
      id: 'u2',
      spotifyId: 'sp2',
      accessToken: 'a',
      refreshToken: 'r',
      tokenExpiresAt: 9999999999999,
      createdAt: 1000,
      updatedAt: 1000,
    });
    const cookie = await cookieFor('u2');
    const res = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Indie Fans' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/groups', () => {
  it('lists a nearby group and flags membership correctly', async () => {
    await makeUser('u2');
    const createCookie = await cookieFor('u2');
    const createRes = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: createCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nearby Group' }),
      }),
      env,
      {} as ExecutionContext
    );
    const { groupId } = await createRes.json<any>();

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/groups', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    const found = body.groups.find((g: any) => g.id === groupId);
    expect(found).toBeTruthy();
    expect(found.memberCount).toBe(1);
    expect(found.isMember).toBe(false); // u1 hasn't joined, only u2 (the creator) has
  });

  it('excludes a group far outside the caller\'s radius', async () => {
    // London, ~7,600km from the Austin coordinates the fixtures use.
    await makeUser('u2', 51.5, -0.12);
    const createCookie = await cookieFor('u2');
    const createRes = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: createCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Far Away Group' }),
      }),
      env,
      {} as ExecutionContext
    );
    const { groupId } = await createRes.json<any>();

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/groups', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.groups.find((g: any) => g.id === groupId)).toBeUndefined();
  });

  it('still lists a group the caller already joined, even if it is now out of radius', async () => {
    // London, ~7,600km away -- but u1 joins anyway (e.g. via a direct link),
    // and their own list must not silently drop it afterward.
    await makeUser('u2', 51.5, -0.12);
    const createRes = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: await cookieFor('u2'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Far Away Group' }),
      }),
      env,
      {} as ExecutionContext
    );
    const { groupId } = await createRes.json<any>();

    const cookie = await cookieFor('u1');
    await worker.fetch(new Request(`http://localhost/api/groups/${groupId}/join`, { method: 'POST', headers: { Cookie: cookie } }), env, {} as ExecutionContext);

    const res = await worker.fetch(new Request('http://localhost/api/groups', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    const found = body.groups.find((g: any) => g.id === groupId);
    expect(found).toBeTruthy();
    expect(found.isMember).toBe(true);
  });
});

describe('GET /api/groups/:id', () => {
  it('returns group details with members for a member', async () => {
    const cookie = await cookieFor('u1');
    const createRes = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Group' }),
      }),
      env,
      {} as ExecutionContext
    );
    const { groupId } = await createRes.json<any>();

    const res = await worker.fetch(new Request(`http://localhost/api/groups/${groupId}`, { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.group.name).toBe('My Group');
    expect(body.group.members).toEqual([{ id: 'u1', displayName: null, photoUrl: null }]);
  });

  it('rejects a non-member', async () => {
    await makeUser('u2');
    const cookie1 = await cookieFor('u1');
    const createRes = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: cookie1, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Group' }),
      }),
      env,
      {} as ExecutionContext
    );
    const { groupId } = await createRes.json<any>();

    const cookie2 = await cookieFor('u2');
    const res = await worker.fetch(new Request(`http://localhost/api/groups/${groupId}`, { headers: { Cookie: cookie2 } }), env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown group', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/groups/does-not-exist', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/groups/:id/join and /leave', () => {
  async function createGroup(cookie: string, name = 'Group') {
    const res = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
      env,
      {} as ExecutionContext
    );
    return (await res.json<any>()).groupId;
  }

  it('joins a group successfully', async () => {
    await makeUser('u2');
    const groupId = await createGroup(await cookieFor('u2'));

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/join`, { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const member = await env.DB.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').bind(groupId, 'u1').first();
    expect(member).toBeTruthy();
  });

  it('is idempotent when already a member', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await createGroup(cookie); // u1 is auto-joined as creator

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/join`, { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').bind(groupId, 'u1').all();
    expect(rows.results.length).toBe(1);
  });

  it('rejects joining once the group is full', async () => {
    const creatorCookie = await cookieFor('u1');
    const groupId = await createGroup(creatorCookie);
    // Fill up to MAX_GROUP_MEMBERS (8) -- u1 is already in, add 7 more.
    for (let i = 2; i <= 8; i++) {
      await makeUser(`u${i}`);
      await worker.fetch(
        new Request(`http://localhost/api/groups/${groupId}/join`, { method: 'POST', headers: { Cookie: await cookieFor(`u${i}`) } }),
        env,
        {} as ExecutionContext
      );
    }

    await makeUser('u9');
    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/join`, { method: 'POST', headers: { Cookie: await cookieFor('u9') } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.error).toBe('group_full');
  });

  it('rejects joining when blocked with an existing member', async () => {
    await makeUser('u2');
    const groupId = await createGroup(await cookieFor('u1')); // u1 is the sole member
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u1', 'u2', 1000)`).run();

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/join`, { method: 'POST', headers: { Cookie: await cookieFor('u2') } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.error).toBe('blocked');
  });

  it('allows leaving, after which messaging is no longer allowed', async () => {
    await makeUser('u2');
    const groupId = await createGroup(await cookieFor('u1'));
    const cookie2 = await cookieFor('u2');
    await worker.fetch(new Request(`http://localhost/api/groups/${groupId}/join`, { method: 'POST', headers: { Cookie: cookie2 } }), env, {} as ExecutionContext);

    const leaveRes = await worker.fetch(new Request(`http://localhost/api/groups/${groupId}/leave`, { method: 'POST', headers: { Cookie: cookie2 } }), env, {} as ExecutionContext);
    expect(leaveRes.status).toBe(200);

    const msgRes = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages`, {
        method: 'POST',
        headers: { Cookie: cookie2, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hello' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(msgRes.status).toBe(403);
  });
});

describe('group messages', () => {
  async function createGroup(cookie: string) {
    const res = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Group' }),
      }),
      env,
      {} as ExecutionContext
    );
    return (await res.json<any>()).groupId;
  }

  it('sends and lists messages for a member', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await createGroup(cookie);

    const sendRes = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Hey everyone!' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(sendRes.status).toBe(200);

    const listRes = await worker.fetch(new Request(`http://localhost/api/groups/${groupId}/messages`, { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await listRes.json<any>();
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].body).toBe('Hey everyone!');
    expect(body.messages[0].sender_id).toBe('u1');
  });

  it('rejects sending with an incomplete profile (issue #36\'s messaging gate)', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await createGroup(cookie);
    await env.DB.prepare(`UPDATE users SET bio = NULL WHERE id = 'u1'`).run();
    await env.DB.prepare(`DELETE FROM user_photos WHERE user_id = 'u1'`).run();

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      }),
      env,
      {} as ExecutionContext
    );

    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.error).toBe('profile_incomplete');
  });

  it('rejects sending with fewer than MIN_LIKED_SONGS liked tracks, even with bio/photos/phone all satisfied', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await createGroup(cookie);
    await env.DB.prepare(`DELETE FROM music_swipes WHERE user_id = 'u1'`).run();

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      }),
      env,
      {} as ExecutionContext
    );

    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.error).toBe('profile_incomplete');
  });

  it('rejects sending with no verified phone number, even with bio/photos/liked songs all satisfied', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await createGroup(cookie);
    await env.DB.prepare(`UPDATE users SET phone_verified_at = NULL WHERE id = 'u1'`).run();

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      }),
      env,
      {} as ExecutionContext
    );

    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.error).toBe('profile_incomplete');
  });

  it('rejects a message from a non-member', async () => {
    await makeUser('u2');
    const groupId = await createGroup(await cookieFor('u1'));

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages`, {
        method: 'POST',
        headers: { Cookie: await cookieFor('u2'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hello' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
  });

  it('applies the same content moderation as 1:1 messages', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await createGroup(cookie);

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'you are a fucking idiot' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_message');
  });
});

describe('POST /api/groups/:id/messages/:messageId/recall', () => {
  async function createGroup(cookie: string) {
    const res = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Group' }),
      }),
      env,
      {} as ExecutionContext
    );
    return (await res.json<any>()).groupId;
  }

  async function insertMessage(id: string, groupId: string, senderId: string, createdAt: number) {
    await env.DB.prepare('INSERT INTO group_messages (id, group_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, groupId, senderId, 'oops', createdAt)
      .run();
  }

  it('recalls the sender\'s own message within the window, nulling body on subsequent reads', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await createGroup(cookie);
    await insertMessage('msg1', groupId, 'u1', Date.now() - 5000);

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages/msg1/recall`, { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT body, recalled_at FROM group_messages WHERE id = ?').bind('msg1').first<any>();
    expect(row.body).toBe('oops');
    expect(row.recalled_at).not.toBeNull();

    const listRes = await worker.fetch(new Request(`http://localhost/api/groups/${groupId}/messages`, { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await listRes.json<any>();
    expect(body.messages[0].body).toBeNull();
    expect(body.messages[0].recalledAt).not.toBeNull();
  });

  it('rejects recalling after the 15s window has passed', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await createGroup(cookie);
    await insertMessage('msg1', groupId, 'u1', Date.now() - 16000);

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages/msg1/recall`, { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('recall_window_expired');
  });

  it('rejects recalling someone else\'s message', async () => {
    await makeUser('u2');
    const cookie1 = await cookieFor('u1');
    const groupId = await createGroup(cookie1);
    await worker.fetch(new Request(`http://localhost/api/groups/${groupId}/join`, { method: 'POST', headers: { Cookie: await cookieFor('u2') } }), env, {} as ExecutionContext);
    await insertMessage('msg1', groupId, 'u1', Date.now() - 1000);

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages/msg1/recall`, { method: 'POST', headers: { Cookie: await cookieFor('u2') } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.error).toBe('not_sender');
  });

  it('rejects recalling a message twice', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await createGroup(cookie);
    await insertMessage('msg1', groupId, 'u1', Date.now() - 1000);
    await worker.fetch(new Request(`http://localhost/api/groups/${groupId}/messages/msg1/recall`, { method: 'POST', headers: { Cookie: cookie } }), env, {} as ExecutionContext);

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages/msg1/recall`, { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('already_recalled');
  });

  it('rejects a non-member outright', async () => {
    await makeUser('u2');
    const groupId = await createGroup(await cookieFor('u1'));
    await insertMessage('msg1', groupId, 'u1', Date.now() - 1000);

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages/msg1/recall`, { method: 'POST', headers: { Cookie: await cookieFor('u2') } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
  });
});

describe('sharing a track in a group thread', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubArtistLookup() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('/v1/artists/')) {
          return new Response(
            JSON.stringify({ id: 'sp-a', name: 'Some Artist', genres: ['indie'], images: [{ url: 'https://i/a.jpg' }], popularity: 10 }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected ${url}`);
      })
    );
  }

  const track = (id: string) => ({
    id,
    name: `Song ${id}`,
    artists: [{ id: 'sp-a', name: 'Some Artist' }],
    album: { images: [{ url: `https://i/${id}.jpg` }] },
    preview_url: null,
  });

  async function makeGroup(cookie: string) {
    const res = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Crate Diggers', topic: 'indie' }),
      }),
      env,
      {} as ExecutionContext
    );
    return (await res.json<any>()).groupId;
  }

  async function share(cookie: string, groupId: string, id: string, body?: string) {
    return worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ track: track(id), body }),
      }),
      env,
      {} as ExecutionContext
    );
  }

  it('stores a shared track and returns it resolved on the thread', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await makeGroup(cookie);
    stubArtistLookup();

    expect((await share(cookie, groupId, 'sp-t1')).status).toBe(200);

    const listed = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages`, { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    const body = await listed.json<any>();
    expect(body.messages[0].track).toMatchObject({ spotifyId: 'sp-t1', artistName: 'Some Artist' });
  });

  it('builds the group crate from every member\'s shared tracks, dropping recalled ones', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await makeGroup(cookie);
    stubArtistLookup();
    await share(cookie, groupId, 'sp-a1');
    await share(cookie, groupId, 'sp-b1');

    const msg = await env.DB.prepare(
      `SELECT m.id FROM group_messages m JOIN tracks t ON t.id = m.track_id WHERE t.spotify_id = 'sp-a1'`
    ).first<{ id: string }>();
    await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages/${msg!.id}/recall`, { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/playlist`, { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    const body = await res.json<any>();
    expect(body.count).toBe(1);
    expect(body.tracks[0].spotifyId).toBe('sp-b1');
  });

  it('is forbidden for a non-member', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await makeGroup(cookie);
    await makeUser('outsider');
    const outsider = await cookieFor('outsider');

    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/playlist`, { headers: { Cookie: outsider } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
  });

  it('still rejects an empty plain message, while allowing a bare track', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await makeGroup(cookie);
    stubArtistLookup();

    expect((await share(cookie, groupId, 'sp-ok')).status).toBe(200);

    const empty = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}/messages`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: '' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(empty.status).toBe(400);
  });
});

describe('group member faces (issue #2)', () => {
  beforeEach(async () => {
    await env.DB.exec(
      'DELETE FROM group_messages; DELETE FROM group_members; DELETE FROM groups; DELETE FROM music_swipes; DELETE FROM user_photos; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
    );
    await makeUser('u1');
  });

  async function createGroup(cookie: string) {
    const res = await worker.fetch(
      new Request('http://localhost/api/groups', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Group', lat: 30.27, lng: -97.74 }),
      }),
      env,
      {} as ExecutionContext
    );
    return (await res.json<any>()).groupId;
  }

  /**
   * makeUser seeds photos with the schema default moderation_status
   * ('pending', migrations/0017), which is exactly the state a freshly
   * uploaded photo is in -- so approving is an explicit step here, matching
   * production.
   */
  async function approvePrimaryPhoto(userId: string) {
    await env.DB.prepare(
      `UPDATE user_photos SET moderation_status = 'approved' WHERE user_id = ? AND position = 0`
    )
      .bind(userId)
      .run();
  }

  async function groupDetail(cookie: string, groupId: string) {
    const res = await worker.fetch(
      new Request(`http://localhost/api/groups/${groupId}`, { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    return (await res.json<any>()).group;
  }

  async function groupList(cookie: string) {
    const res = await worker.fetch(
      new Request('http://localhost/api/groups', { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    return (await res.json<any>()).groups;
  }

  it('returns each member photo url on the group detail', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await createGroup(cookie);
    await approvePrimaryPhoto('u1');

    const group = await groupDetail(cookie, groupId);

    expect(group.members[0].photoUrl).toBe('/photos/photo-u1-0');
  });

  it('hands back null for a photo moderation has not approved', async () => {
    // GET /photos/:id hides a pending/flagged photo from everyone but its
    // owner, so returning it here would render a broken image for every
    // other member. Same rule the people deck already applies.
    const cookie = await cookieFor('u1');
    const groupId = await createGroup(cookie);

    const group = await groupDetail(cookie, groupId);

    expect(group.members[0].photoUrl).toBeNull();
  });

  it('puts member faces on the group list cards', async () => {
    const cookie = await cookieFor('u1');
    await createGroup(cookie);
    await approvePrimaryPhoto('u1');

    expect((await groupList(cookie))[0].memberFaces).toEqual(['/photos/photo-u1-0']);
  });

  it('omits members with no approved photo rather than emitting blanks', async () => {
    // A row of empty circles reads as broken; the member count beside the
    // stack already tells the real story.
    const cookie = await cookieFor('u1');
    await createGroup(cookie);
    const groups = await groupList(cookie);

    expect(groups[0].memberFaces).toEqual([]);
    expect(groups[0].memberCount).toBe(1);
  });

  it('caps the faces on a card so a full group does not overflow it', async () => {
    const cookie = await cookieFor('u1');
    const groupId = await createGroup(cookie);
    await approvePrimaryPhoto('u1');
    for (let i = 2; i <= 8; i++) {
      await makeUser(`u${i}`);
      await approvePrimaryPhoto(`u${i}`);
      await worker.fetch(
        new Request(`http://localhost/api/groups/${groupId}/join`, { method: 'POST', headers: { Cookie: await cookieFor(`u${i}`) } }),
        env,
        {} as ExecutionContext
      );
    }

    const card = (await groupList(cookie))[0];

    expect(card.memberCount).toBe(8);
    expect(card.memberFaces).toHaveLength(5);
    // Oldest members first, so the stack is stable as people join.
    expect(card.memberFaces[0]).toBe('/photos/photo-u1-0');
  });
});
