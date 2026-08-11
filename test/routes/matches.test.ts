import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import { getMatchNotificationDelayMs } from '../../src/lib/notifications';
import { MIN_PHOTOS, MIN_LIKED_SONGS } from '../../src/lib/messagingGate';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function makeUser(id: string, email: string | null, displayName: string | null = null) {
  await insertTestUser(env.DB, {
    id,
    spotifyId: `sp-${id}`,
    email,
    displayName,
    // Message-eligible by default (issue #36's profile-completeness gate,
    // src/lib/messagingGate.ts) -- this file's tests are about message
    // content/read-status/etc., not about the gate itself, so the ambient
    // users shouldn't need every test to separately clear that precondition.
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
  // item_id carries no FK to tracks (see messagingGate.test.ts's identical
  // comment) -- fabricated ids are fine, this is a plain COUNT query.
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
  // Child rows before parent `users` rows -- D1 enforces FK constraints here.
  // messages -> matches, users; notifications -> users; matches -> users; sessions -> users.
  await env.DB.exec(
    'DELETE FROM messages; DELETE FROM notifications; DELETE FROM sessions; DELETE FROM matches; ' +
      'DELETE FROM user_photos; DELETE FROM music_swipes; DELETE FROM user_genres; DELETE FROM tracks; DELETE FROM artists; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
  await makeUser('u1', 'u1@example.com', 'User One');
  await makeUser('u2', 'u2@example.com', 'User Two');
  await makeUser('u3', null);
  await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m1', 'u1', 'u2', 1000)`).run();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

describe('GET /api/matches', () => {
  it('lists active matches with the other participant', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/matches', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.matches[0].otherUserId).toBe('u2');
    expect(body.matches[0].otherDisplayName).toBe('User Two');
  });

  it('excludes a match after it is unmatched', async () => {
    const cookie = await cookieFor('u1');
    await worker.fetch(
      new Request('http://localhost/api/matches/m1/unmatch', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    const res = await worker.fetch(new Request('http://localhost/api/matches', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.matches.length).toBe(0);
  });

  it('hides a match whose other participant has been soft-deleted', async () => {
    // A soft-deleted account must "disappear from all candidate pools,
    // matches, and search right away" (docs/PLAN.md) -- not linger for the
    // whole 7-day grace period before the hard purge runs.
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(2000, 'u2').run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/matches', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.matches.length).toBe(0);
  });

  it('hides a match from the non-ghosted participant once the other side is ghosted, but not from the ghosted side itself', async () => {
    // Ghosting (src/lib/reports.ts) is asymmetric, unlike a soft-delete: the
    // ghosted user keeps using the app completely normally, unaware -- only
    // OTHERS lose the ability to see or interact with them.
    await env.DB.prepare('UPDATE users SET ghosted_at = ? WHERE id = ?').bind(2000, 'u2').run();

    const u1Cookie = await cookieFor('u1');
    const u1Res = await worker.fetch(new Request('http://localhost/api/matches', { headers: { Cookie: u1Cookie } }), env, {} as ExecutionContext);
    const u1Body = await u1Res.json<any>();
    expect(u1Body.matches.length).toBe(0);

    const u2Cookie = await cookieFor('u2');
    const u2Res = await worker.fetch(new Request('http://localhost/api/matches', { headers: { Cookie: u2Cookie } }), env, {} as ExecutionContext);
    const u2Body = await u2Res.json<any>();
    expect(u2Body.matches.length).toBe(1);
    expect(u2Body.matches[0].otherUserId).toBe('u1');
  });

  it('hides a match less than the delay old -- passive discovery only, per getMatchNotificationDelayMs', async () => {
    const delayMs = getMatchNotificationDelayMs(env);
    await env.DB.prepare('UPDATE matches SET created_at = ? WHERE id = ?').bind(Date.now() - (delayMs - 60 * 1000), 'm1').run(); // 1 minute inside the window
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/matches', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.matches.length).toBe(0);
  });

  it('includes a match once the delay has passed', async () => {
    const delayMs = getMatchNotificationDelayMs(env);
    await env.DB.prepare('UPDATE matches SET created_at = ? WHERE id = ?').bind(Date.now() - (delayMs + 60 * 1000), 'm1').run(); // 1 minute past the window
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/matches', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.matches.length).toBe(1);
  });

  it('rejects an unmatch attempt from a non-participant and leaves the match active', async () => {
    const cookie = await cookieFor('u3');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/unmatch', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(404);

    const match = await env.DB.prepare('SELECT unmatched_at FROM matches WHERE id = ?').bind('m1').first<any>();
    expect(match.unmatched_at).toBeNull();
  });
});

describe('GET /api/matches/:id', () => {
  it('rejects a non-participant', async () => {
    const cookie = await cookieFor('u3');
    const res = await worker.fetch(new Request('http://localhost/api/matches/m1', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('blocks viewing a match whose other participant has been soft-deleted', async () => {
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(2000, 'u2').run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/matches/m1', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('blocks the non-ghosted participant from viewing the match, but not the ghosted participant themselves', async () => {
    await env.DB.prepare('UPDATE users SET ghosted_at = ? WHERE id = ?').bind(2000, 'u2').run();

    const u1Cookie = await cookieFor('u1');
    const u1Res = await worker.fetch(new Request('http://localhost/api/matches/m1', { headers: { Cookie: u1Cookie } }), env, {} as ExecutionContext);
    expect(u1Res.status).toBe(403);

    const u2Cookie = await cookieFor('u2');
    const u2Res = await worker.fetch(new Request('http://localhost/api/matches/m1', { headers: { Cookie: u2Cookie } }), env, {} as ExecutionContext);
    expect(u2Res.status).toBe(200);
    const u2Body = await u2Res.json<any>();
    expect(u2Body.match.otherUserId).toBe('u1');
  });

  it('returns the other participant', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/matches/m1', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.match.otherUserId).toBe('u2');
    expect(body.match.otherDisplayName).toBe('User Two');
  });

  it('returns artists and tracks both participants right-swiped', async () => {
    await env.DB.prepare(`INSERT INTO artists (id, name, genres, image_url, source, approved, created_at) VALUES ('art1', 'Shared Artist', '[]', 'https://img.example/art1.jpg', 'seed', 1, 1000)`).run();
    await env.DB.prepare(`INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('art2', 'Only Mine', '[]', 'seed', 1, 1000)`).run();
    await env.DB.prepare(`INSERT INTO tracks (id, spotify_id, name, artist_id, album_image_url, source, approved, created_at) VALUES ('trk1', 'sp-trk1', 'Shared Track', 'art1', 'https://img.example/trk1.jpg', 'seed', 1, 1000)`).run();

    for (const [userId, itemType, itemId] of [
      ['u1', 'artist', 'art1'],
      ['u2', 'artist', 'art1'],
      ['u1', 'artist', 'art2'], // only u1 liked this one -- must not appear
      ['u1', 'track', 'trk1'],
      ['u2', 'track', 'trk1'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES (?, ?, ?, ?, 'right', 1000, 1000)`
      ).bind(`${userId}-${itemType}-${itemId}`, userId, itemType, itemId).run();
    }

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/matches/m1', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.overlap.sharedArtists.map((a: any) => a.id)).toEqual(['art1']);
    expect(body.overlap.sharedArtists[0].imageUrl).toBe('https://img.example/art1.jpg');
    expect(body.overlap.sharedTracks.map((t: any) => t.id)).toEqual(['trk1']);
    expect(body.overlap.sharedTracks[0].imageUrl).toBe('https://img.example/trk1.jpg');
    // The real Spotify id, for profile.html's embed player -- distinct from
    // `id` (our internal catalog UUID) since migrations/0002 obfuscated it.
    expect(body.overlap.sharedTracks[0].spotifyId).toBe('sp-trk1');
  });

  it('returns genres both participants have affinity for', async () => {
    await env.DB.prepare(`INSERT INTO user_genres (id, user_id, genre, artist_count, track_count, created_at, updated_at) VALUES ('ug5', 'u1', 'indie', 3, 0, 1000, 1000)`).run();
    await env.DB.prepare(`INSERT INTO user_genres (id, user_id, genre, artist_count, track_count, created_at, updated_at) VALUES ('ug6', 'u2', 'indie', 5, 0, 1000, 1000)`).run();
    await env.DB.prepare(`INSERT INTO user_genres (id, user_id, genre, artist_count, track_count, created_at, updated_at) VALUES ('ug7', 'u1', 'metal', 2, 0, 1000, 1000)`).run(); // u2 has no affinity for this

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/matches/m1', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.overlap.sharedGenres).toEqual([{ genre: 'indie', myCount: 3, theirCount: 5 }]);
  });
});

describe('messages', () => {
  it('rejects a non-participant', async () => {
    const cookie = await cookieFor('u3');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
  });

  it('rejects sending with an incomplete profile (issue #36\'s messaging gate)', async () => {
    await env.DB.prepare(`UPDATE users SET bio = NULL WHERE id = 'u1'`).run();
    await env.DB.prepare(`DELETE FROM user_photos WHERE user_id = 'u1'`).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
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
    const messages = await env.DB.prepare('SELECT * FROM messages WHERE match_id = ?').bind('m1').all<any>();
    expect(messages.results.length).toBe(0);
  });

  it('rejects sending with fewer than MIN_LIKED_SONGS liked tracks, even with bio/photos/phone all satisfied', async () => {
    await env.DB.prepare(`DELETE FROM music_swipes WHERE user_id = 'u1'`).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
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
    await env.DB.prepare(`UPDATE users SET phone_verified_at = NULL WHERE id = 'u1'`).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
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

  it('sends a message, notifies, and emails the recipient', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hey there' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const messages = await env.DB.prepare('SELECT * FROM messages WHERE match_id = ?').bind('m1').all<any>();
    expect(messages.results.length).toBe(1);

    const notification = await env.DB.prepare("SELECT * FROM notifications WHERE type = 'message' AND user_id = 'u2'").first<any>();
    expect(notification).toBeTruthy();
    expect(notification.email_sent_at).not.toBeNull();
  });

  it('still sends the message and returns 200 when Resend errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('service unavailable', { status: 503 })));
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hey there' }),
      }),
      env,
      {} as ExecutionContext
    );

    // The message write and notification row are already committed by the
    // time notifyMessage runs; an email-provider failure must not turn this
    // into a failed request.
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.ok).toBe(true);

    const messages = await env.DB.prepare('SELECT * FROM messages WHERE match_id = ?').bind('m1').all<any>();
    expect(messages.results.length).toBe(1);

    const notification = await env.DB.prepare("SELECT * FROM notifications WHERE type = 'message' AND user_id = 'u2'").first<any>();
    expect(notification).toBeTruthy();
    expect(notification.email_sent_at).toBeNull(); // send failed, never stamped
  });

  it('blocks messaging when the other participant has been soft-deleted', async () => {
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(2000, 'u2').run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);

    const messages = await env.DB.prepare('SELECT * FROM messages WHERE match_id = ?').bind('m1').all<any>();
    expect(messages.results.length).toBe(0);
    expect(fetch).not.toHaveBeenCalled(); // no email to a deleted user's address
  });

  it('rejects a blank message body and writes nothing', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: '   ' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_message');
    const messages = await env.DB.prepare('SELECT * FROM messages WHERE match_id = ?').bind('m1').all<any>();
    expect(messages.results.length).toBe(0);
  });

  it('rejects a message containing disallowed characters and writes nothing', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'check this out: http://evil.example' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_message');
  });

  it('rejects a message containing a blocked word and writes nothing', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
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
    const messages = await env.DB.prepare('SELECT * FROM messages WHERE match_id = ?').bind('m1').all<any>();
    expect(messages.results.length).toBe(0);
  });

  it('accepts a message with normal punctuation', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: "Hey, what's up?" }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
  });

  it('blocks reading messages when the other participant has been soft-deleted', async () => {
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(2000, 'u2').run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
  });

  it('blocks unmatching a match whose other participant has been soft-deleted', async () => {
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(2000, 'u2').run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/unmatch', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(404);
  });

  it('blocks messaging after unmatch', async () => {
    const cookie = await cookieFor('u1');
    await worker.fetch(new Request('http://localhost/api/matches/m1/unmatch', { method: 'POST', headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /api/matches/:id/messages/:messageId/recall', () => {
  async function insertMessage(id: string, senderId: string, createdAt: number) {
    await env.DB.prepare('INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, 'm1', senderId, 'oops', createdAt)
      .run();
  }

  it('recalls the sender\'s own message within the window, nulling body on subsequent reads', async () => {
    await insertMessage('msg1', 'u1', Date.now() - 5000);
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages/msg1/recall', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    // The raw row is untouched -- only marked, never deleted.
    const row = await env.DB.prepare('SELECT body, recalled_at FROM messages WHERE id = ?').bind('msg1').first<any>();
    expect(row.body).toBe('oops');
    expect(row.recalled_at).not.toBeNull();

    const listRes = await worker.fetch(new Request('http://localhost/api/matches/m1/messages', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await listRes.json<any>();
    expect(body.messages[0].body).toBeNull();
    expect(body.messages[0].recalledAt).not.toBeNull();
  });

  it('rejects recalling after the 15s window has passed', async () => {
    await insertMessage('msg1', 'u1', Date.now() - 16000);
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages/msg1/recall', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('recall_window_expired');
  });

  it('rejects recalling someone else\'s message', async () => {
    await insertMessage('msg1', 'u2', Date.now() - 1000);
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages/msg1/recall', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.error).toBe('not_sender');
  });

  it('rejects recalling a message twice', async () => {
    await insertMessage('msg1', 'u1', Date.now() - 1000);
    const cookie = await cookieFor('u1');
    await worker.fetch(new Request('http://localhost/api/matches/m1/messages/msg1/recall', { method: 'POST', headers: { Cookie: cookie } }), env, {} as ExecutionContext);

    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages/msg1/recall', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('already_recalled');
  });

  it('returns 404 for a message that does not belong to this match', async () => {
    await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m2', 'u1', 'u3', 1000)`).run();
    await env.DB.prepare('INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('msg-other', 'm2', 'u1', 'hi', Date.now())
      .run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages/msg-other/recall', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(404);
  });

  it('rejects a non-participant outright', async () => {
    await insertMessage('msg1', 'u1', Date.now() - 1000);
    const cookie = await cookieFor('u3');

    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages/msg1/recall', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
  });
});
