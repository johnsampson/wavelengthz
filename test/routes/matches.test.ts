import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import { getMatchNotificationDelayMs } from '../../src/lib/notifications';
import { MIN_PHOTOS, MIN_ARTISTS_ACTED } from '../../src/lib/messagingGate';
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
  // item_id carries no FK to artists (see messagingGate.test.ts's identical
  // comment) -- fabricated ids are fine, this is a plain COUNT query.
  for (let i = 0; i < MIN_ARTISTS_ACTED; i++) {
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES (?, ?, 'artist', ?, 'right', 1000, 1000)`
    )
      .bind(`swiped-${id}-${i}`, id, `artist-${id}-${i}`)
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

  it('rejects sending with fewer than MIN_ARTISTS_ACTED artists acted on, even with bio/photos/phone all satisfied', async () => {
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

  it('rejects sending with no verified phone number, even with bio/photos/artists-acted-on all satisfied', async () => {
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

describe('sharing a track in a match thread', () => {
  /** Only the token + GET /v1/artists/{id} are legal here; anything else throws. */
  function stubArtistLookup() {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        calls.push(url);
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('/v1/artists/')) {
          return new Response(
            JSON.stringify({ id: 'sp-artist-1', name: 'Some Artist', genres: ['indie'], images: [{ url: 'https://i/a.jpg' }], popularity: 60 }),
            { status: 200 }
          );
        }
        // Resend (notifyMessage) -- unrelated to what these tests assert.
        return new Response('{}', { status: 200 });
      })
    );
    return calls;
  }

  const track = (id = 'sp-t1') => ({
    id,
    name: `Song ${id}`,
    artists: [{ id: 'sp-artist-1', name: 'Some Artist' }],
    album: { images: [{ url: `https://i/${id}.jpg` }] },
    preview_url: null,
  });

  async function share(cookie: string, body: any) {
    return worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      {} as ExecutionContext
    );
  }

  it('stores a shared track and returns it, resolved, on the thread', async () => {
    stubArtistLookup();
    const cookie = await cookieFor('u1');

    const res = await share(cookie, { track: track() });
    expect(res.status).toBe(200);

    const listed = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    const body = await listed.json<any>();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].track).toMatchObject({ spotifyId: 'sp-t1', name: 'Song sp-t1', artistName: 'Some Artist' });
    // Internal id, not the Spotify one -- the player bar needs spotifyId, the
    // rest of the app needs the catalog id.
    expect(body.messages[0].track.id).not.toBe('sp-t1');
  });

  it('accepts an optional caption alongside the track', async () => {
    stubArtistLookup();
    const cookie = await cookieFor('u1');

    await share(cookie, { track: track(), body: 'this one is you' });

    const listed = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    const body = await listed.json<any>();
    expect(body.messages[0].body).toBe('this one is you');
    expect(body.messages[0].track).not.toBeNull();
  });

  it('allows an empty body for a track, but still rejects one for a plain message', async () => {
    stubArtistLookup();
    const cookie = await cookieFor('u1');

    expect((await share(cookie, { track: track() })).status).toBe(200);
    expect((await share(cookie, { body: '' })).status).toBe(400);
  });

  it('still applies the caption charset rules -- a caption is as visible as any message', async () => {
    stubArtistLookup();
    const cookie = await cookieFor('u1');

    const res = await share(cookie, { track: track(), body: 'check this https://evil.example' });

    expect(res.status).toBe(400);
    expect((await res.json<any>()).error).toBe('invalid_message');
  });

  it('reports 503 (not 400) when Spotify cannot resolve the artist, and stores nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const cookie = await cookieFor('u1');

    const res = await share(cookie, { track: track() });

    expect(res.status).toBe(503);
    expect((await res.json<any>()).error).toBe('artist_unavailable');
    const count = await env.DB.prepare('SELECT COUNT(*) c FROM messages').first<{ c: number }>();
    expect(count?.c).toBe(0);
  });

  it('notifies the recipient exactly as a text message does', async () => {
    stubArtistLookup();
    const cookie = await cookieFor('u1');

    await share(cookie, { track: track() });

    const note = await env.DB.prepare(`SELECT user_id, type FROM notifications WHERE type = 'message'`).first<any>();
    expect(note.user_id).toBe('u2');
  });
});

describe('GET /api/matches/:id/playlist', () => {
  function stubArtistLookup() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('/v1/artists/')) {
          return new Response(
            JSON.stringify({ id: 'sp-artist-1', name: 'Some Artist', genres: [], images: [{ url: 'https://i/a.jpg' }], popularity: 1 }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      })
    );
  }

  const track = (id: string) => ({
    id,
    name: `Song ${id}`,
    artists: [{ id: 'sp-artist-1', name: 'Some Artist' }],
    album: { images: [{ url: `https://i/${id}.jpg` }] },
    preview_url: null,
  });

  async function share(cookie: string, id: string) {
    return worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ track: track(id) }),
      }),
      env,
      {} as ExecutionContext
    );
  }

  async function playlist(cookie: string) {
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/playlist', { headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    // 403 comes back as plain text ('Forbidden'), not JSON -- only parse on OK.
    return { status: res.status, body: res.ok ? await res.json<any>() : null };
  }

  it('is empty for a thread with no shared tracks, even with plain messages in it', async () => {
    stubArtistLookup();
    const cookie = await cookieFor('u1');
    await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'just talking' }),
      }),
      env,
      {} as ExecutionContext
    );

    const { body } = await playlist(cookie);
    expect(body).toEqual({ tracks: [], count: 0 });
  });

  it('accumulates tracks from both participants, oldest first', async () => {
    stubArtistLookup();
    const c1 = await cookieFor('u1');
    const c2 = await cookieFor('u2');
    await share(c1, 'sp-a');
    await share(c2, 'sp-b');

    const { body } = await playlist(c1);
    expect(body.count).toBe(2);
    expect(body.tracks.map((t: any) => t.spotifyId)).toEqual(['sp-a', 'sp-b']);
    expect(body.tracks[0].sharedBy).toBe('u1');
    expect(body.tracks[1].sharedBy).toBe('u2');
  });

  it('lists a re-sent song once, at its first appearance', async () => {
    stubArtistLookup();
    const c1 = await cookieFor('u1');
    await share(c1, 'sp-a');
    await share(c1, 'sp-b');
    await share(c1, 'sp-a');

    const { body } = await playlist(c1);
    expect(body.tracks.map((t: any) => t.spotifyId)).toEqual(['sp-a', 'sp-b']);
  });

  // The reason the playlist is derived from messages rather than stored
  // separately: un-sending has to actually un-share.
  it('drops a track from the playlist when its message is recalled', async () => {
    stubArtistLookup();
    const c1 = await cookieFor('u1');
    await share(c1, 'sp-a');
    await share(c1, 'sp-b');

    const msg = await env.DB.prepare(
      `SELECT m.id FROM messages m JOIN tracks t ON t.id = m.track_id WHERE t.spotify_id = 'sp-a'`
    ).first<{ id: string }>();
    const recalled = await worker.fetch(
      new Request(`http://localhost/api/matches/m1/messages/${msg!.id}/recall`, { method: 'POST', headers: { Cookie: c1 } }),
      env,
      {} as ExecutionContext
    );
    expect(recalled.status).toBe(200);

    const { body } = await playlist(c1);
    expect(body.count).toBe(1);
    expect(body.tracks.map((t: any) => t.spotifyId)).toEqual(['sp-b']);
  });

  it('hides a recalled track from the thread itself too, not just the playlist', async () => {
    stubArtistLookup();
    const c1 = await cookieFor('u1');
    await share(c1, 'sp-a');
    const msg = await env.DB.prepare('SELECT id FROM messages LIMIT 1').first<{ id: string }>();
    await worker.fetch(
      new Request(`http://localhost/api/matches/m1/messages/${msg!.id}/recall`, { method: 'POST', headers: { Cookie: c1 } }),
      env,
      {} as ExecutionContext
    );

    const listed = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', { headers: { Cookie: c1 } }),
      env,
      {} as ExecutionContext
    );
    const body = await listed.json<any>();
    expect(body.messages[0].track).toBeNull();
    expect(body.messages[0].body).toBeNull();
  });

  it('is forbidden for someone outside the match', async () => {
    const c3 = await cookieFor('u3');
    const { status } = await playlist(c3);
    expect(status).toBe(403);
  });
});
