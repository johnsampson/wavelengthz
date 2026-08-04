import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function makeUser(id: string, email: string | null, displayName: string | null = null) {
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, email, display_name, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`, email, displayName).run();
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
      'DELETE FROM music_swipes; DELETE FROM user_genres; DELETE FROM tracks; DELETE FROM artists; DELETE FROM users;'
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
    await env.DB.prepare(`INSERT INTO tracks (id, name, artist_id, album_image_url, source, approved, created_at) VALUES ('trk1', 'Shared Track', 'art1', 'https://img.example/trk1.jpg', 'seed', 1, 1000)`).run();

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
  });

  it('returns genres both participants have affinity for', async () => {
    await env.DB.prepare(`INSERT INTO user_genres (user_id, genre, artist_count, track_count, updated_at) VALUES ('u1', 'indie', 3, 0, 1000)`).run();
    await env.DB.prepare(`INSERT INTO user_genres (user_id, genre, artist_count, track_count, updated_at) VALUES ('u2', 'indie', 5, 0, 1000)`).run();
    await env.DB.prepare(`INSERT INTO user_genres (user_id, genre, artist_count, track_count, updated_at) VALUES ('u1', 'metal', 2, 0, 1000)`).run(); // u2 has no affinity for this

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
