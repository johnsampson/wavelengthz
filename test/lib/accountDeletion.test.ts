import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { hardDeleteUser, purgeExpiredDeletions } from '../../src/lib/accountDeletion';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function seedFullUser(id: string) {
  await insertTestUser(env.DB, { id, spotifyId: `sp-${id}` });
}

beforeEach(async () => {
  // Children before parents: reports/messages/etc. reference users (and messages
  // references matches) via FK columns that D1 enforces, so a prior test's
  // hardDeleteUser call can leave rows (e.g. a kept "reported" report, or a
  // still-live counterpart user) that would trip the constraint if `users` were
  // wiped first. See test/routes/catalog.test.ts for the same pattern.
  await env.DB.exec(`
    DELETE FROM messages; DELETE FROM matches; DELETE FROM user_photos;
    DELETE FROM people_swipes; DELETE FROM music_swipes; DELETE FROM user_genres; DELETE FROM music_profiles;
    DELETE FROM blocks; DELETE FROM reports; DELETE FROM notifications; DELETE FROM sessions;
    DELETE FROM push_subscriptions;
    DELETE FROM tracks; DELETE FROM artists;
    DELETE FROM music_source_tokens; DELETE FROM auth_identities;
    DELETE FROM users;
  `);
});

describe('hardDeleteUser', () => {
  it('purges the user row, their photos (D1 + R2), and everything referencing them', async () => {
    await seedFullUser('u1');
    await seedFullUser('u2');
    await env.PHOTOS.put('users/u1/p1.jpg', 'fake-bytes');
    await env.DB.prepare(`INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u1', 'users/u1/p1.jpg', 0, 1000)`).run();
    await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m1', 'u1', 'u2', 1000)`).run();
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm1', 'u1', 'hi', 1000)`).run();
    await env.DB.prepare(`INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('ps1', 'u1', 'u2', 'right', 1000, 1000)`).run();
    await env.DB.prepare(`INSERT INTO reports (id, reporter_id, reported_id, reason, status, created_at) VALUES ('r1', 'u1', 'u2', 'spam', 'open', 1000)`).run();
    await env.DB.prepare(`INSERT INTO reports (id, reporter_id, reported_id, reason, status, created_at) VALUES ('r2', 'u2', 'u1', 'spam', 'open', 1000)`).run();
    await env.DB.prepare(`INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('msw1', 'u1', 'artist', 'artist-x', 'right', 1000, 1000)`).run();
    await env.DB.prepare(`INSERT INTO user_genres (user_id, genre, artist_count, track_count, updated_at) VALUES ('u1', 'pop', 3, 0, 1000)`).run();
    await env.DB.prepare(`INSERT INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at) VALUES ('u1', '[]', '[]', '[]', 'medium_term', 1000)`).run();
    await env.DB.prepare(`INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ('b1', 'u1', 'u2', 1000)`).run();
    await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n1', 'u1', 'match', 'm1', 1000)`).run();
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('ps-sub-1', 'u1', 'https://push.example/u1-device', 'p256dh-key', 'auth-key', 1000)`
    ).run();
    const { id: sessionId } = await createSession(env.DB, 'u1');

    await hardDeleteUser(env as any, 'u1');

    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM auth_identities WHERE user_id = ?').bind('u1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM music_source_tokens WHERE user_id = ?').bind('u1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM user_photos WHERE user_id = ?').bind('u1').first()).toBeNull();
    expect(await env.PHOTOS.get('users/u1/p1.jpg')).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM matches WHERE id = ?').bind('m1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind('msg1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM people_swipes WHERE id = ?').bind('ps1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind('r1').first()).toBeNull(); // u1 was reporter
    expect(await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind('r2').first()).not.toBeNull(); // u1 was reported — kept
    expect(await env.DB.prepare('SELECT * FROM music_swipes WHERE id = ?').bind('msw1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM user_genres WHERE user_id = ?').bind('u1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM music_profiles WHERE user_id = ?').bind('u1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM blocks WHERE id = ?').bind('b1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM notifications WHERE id = ?').bind('n1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM push_subscriptions WHERE id = ?').bind('ps-sub-1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first()).toBeNull();
  });
});

describe('hardDeleteUser and catalog attribution', () => {
  it('nulls added_by_user_id on artists/tracks the user added, rather than leaving it dangling', async () => {
    // artists.added_by_user_id / tracks.added_by_user_id are nullable FKs to users(id),
    // populated by the catalog search-and-add feature (src/routes/catalog.ts). The
    // catalog rows themselves outlive the user, so hardDeleteUser must null the
    // attribution rather than leave it pointing at a row it's about to delete —
    // D1 enforces this FK too.
    await seedFullUser('u1');
    await env.DB.prepare(
      `INSERT INTO artists (id, name, genres, source, added_by_user_id, approved, created_at) VALUES ('a1', 'User Added Artist', '{"pop":true}', 'user_added', 'u1', 1, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, name, artist_id, source, added_by_user_id, approved, created_at) VALUES ('t1', 'User Added Track', 'a1', 'user_added', 'u1', 1, 1000)`
    ).run();

    await hardDeleteUser(env as any, 'u1');

    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first()).toBeNull();
    const artist = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind('a1').first<any>();
    expect(artist).not.toBeNull();
    expect(artist.added_by_user_id).toBeNull();
    const track = await env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind('t1').first<any>();
    expect(track).not.toBeNull();
    expect(track.added_by_user_id).toBeNull();
  });
});

describe('purgeExpiredDeletions', () => {
  it('hard-deletes only users past the grace period', async () => {
    const GRACE = 7 * 24 * 60 * 60 * 1000;
    const now = 100_000_000_000;
    await seedFullUser('old');
    await seedFullUser('recent');
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(now - GRACE - 1000, 'old').run();
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(now - 1000, 'recent').run();

    const result = await purgeExpiredDeletions(env as any, GRACE, now);

    expect(result.purgedCount).toBe(1);
    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('old').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('recent').first()).not.toBeNull();
  });

  it('isolates a per-user failure so the rest of the batch is still purged, and reports it', async () => {
    // Previously one bad user aborted the whole loop, and the caller wraps
    // this in ctx.waitUntil(...) with no .catch() -- so the remaining expired
    // accounts silently accumulated forever with zero visibility.
    const GRACE = 7 * 24 * 60 * 60 * 1000;
    const now = 100_000_000_000;
    for (const id of ['a', 'boom', 'c']) {
      await seedFullUser(id);
      await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(now - GRACE - 1000, id).run();
    }
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'boom', 'users/boom/p1.jpg', 0, 1000)`
    ).run();

    const sentryCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        sentryCalls.push(String(url));
        return new Response('', { status: 200 });
      })
    );

    // hardDeleteUser only ever calls PHOTOS.delete; make it throw for one user.
    const failingEnv = {
      ...env,
      PHOTOS: {
        delete: async (key: string) => {
          if (key.includes('boom')) throw new Error('R2 unavailable');
          return env.PHOTOS.delete(key);
        },
      },
    } as any;

    const result = await purgeExpiredDeletions(failingEnv, GRACE, now);

    expect(result.purgedCount).toBe(2);
    expect(result.failedIds).toEqual(['boom']);
    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('a').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('c').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('boom').first()).not.toBeNull();
    expect(sentryCalls.some((u) => u.includes('/envelope/'))).toBe(true);

    vi.unstubAllGlobals();
  });

  it('reports nothing and purges everything when the batch is clean', async () => {
    const GRACE = 7 * 24 * 60 * 60 * 1000;
    const now = 100_000_000_000;
    await seedFullUser('a');
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(now - GRACE - 1000, 'a').run();

    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await purgeExpiredDeletions(env as any, GRACE, now);

    expect(result.purgedCount).toBe(1);
    expect(result.failedIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
