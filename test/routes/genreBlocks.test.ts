import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM user_blocked_genres; DELETE FROM genres; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', createdAt: 1000, updatedAt: 1000 });
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

describe('GET /api/genres/blocked', () => {
  it('returns an empty list when nothing is blocked', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/genres/blocked', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.genres).toEqual([]);
  });

  it('lists blocked genres alphabetically', async () => {
    await env.DB.prepare(`INSERT INTO user_blocked_genres (id, user_id, genre, created_at, updated_at) VALUES ('b1', 'u1', 'rock', 1000, 1000)`).run();
    await env.DB.prepare(`INSERT INTO user_blocked_genres (id, user_id, genre, created_at, updated_at) VALUES ('b2', 'u1', 'country', 1000, 1000)`).run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/genres/blocked', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.genres).toEqual(['country', 'rock']);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/genres/blocked'), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/genres/search', () => {
  async function seedGenre(genre: string, artistCount: number, trackCount = 0) {
    await env.DB.prepare(
      `INSERT INTO genres (id, genre, artist_count, track_count, created_at, updated_at) VALUES (?, ?, ?, ?, 1000, 1000)`
    ).bind(crypto.randomUUID(), genre, artistCount, trackCount).run();
  }

  it('rejects an unauthenticated request', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/genres/search?q=rock'), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('returns an empty list for an empty query rather than the whole catalog', async () => {
    await seedGenre('rock', 5);
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/genres/search?q=', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.genres).toEqual([]);
  });

  it('matches by substring, most-used first', async () => {
    await seedGenre('classic rock', 3);
    await seedGenre('rock', 10);
    await seedGenre('country', 20); // doesn't match "rock"
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/genres/search?q=rock', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.genres).toEqual(['rock', 'classic rock']);
  });

  it('excludes a genre the user has already blocked', async () => {
    await seedGenre('rock', 5);
    await seedGenre('classic rock', 3);
    await env.DB.prepare(`INSERT INTO user_blocked_genres (id, user_id, genre, created_at, updated_at) VALUES ('b1', 'u1', 'rock', 1000, 1000)`).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/genres/search?q=rock', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.genres).toEqual(['classic rock']);
  });

  it("does not leak another user's blocked genres into the exclusion", async () => {
    await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp2', createdAt: 1000, updatedAt: 1000 });
    await seedGenre('rock', 5);
    await env.DB.prepare(`INSERT INTO user_blocked_genres (id, user_id, genre, created_at, updated_at) VALUES ('b1', 'u2', 'rock', 1000, 1000)`).run();
    const cookie = await cookieFor('u1');

    const res = await worker.fetch(new Request('http://localhost/api/genres/search?q=rock', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();

    expect(body.genres).toEqual(['rock']);
  });
});

describe('POST /api/genres/:genre/block', () => {
  it('adds the genre to the user\'s blocked list', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/genres/country/block', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM user_blocked_genres WHERE user_id = ? AND genre = ?').bind('u1', 'country').first();
    expect(row).toBeTruthy();
  });

  it('is idempotent -- blocking an already-blocked genre does not error or duplicate', async () => {
    const cookie = await cookieFor('u1');
    const req = () => new Request('http://localhost/api/genres/country/block', { method: 'POST', headers: { Cookie: cookie } });
    await worker.fetch(req(), env, {} as ExecutionContext);
    const res2 = await worker.fetch(req(), env, {} as ExecutionContext);
    expect(res2.status).toBe(200);
    const rows = await env.DB.prepare('SELECT * FROM user_blocked_genres WHERE user_id = ? AND genre = ?').bind('u1', 'country').all();
    expect(rows.results).toHaveLength(1);
  });

  it('decodes a URL-encoded multi-word genre name', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/genres/deep%20house/block', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM user_blocked_genres WHERE user_id = ? AND genre = ?').bind('u1', 'deep house').first();
    expect(row).toBeTruthy();
  });
});

describe('POST /api/genres/:genre/unblock', () => {
  it('removes the genre from the user\'s blocked list', async () => {
    await env.DB.prepare(`INSERT INTO user_blocked_genres (id, user_id, genre, created_at, updated_at) VALUES ('b1', 'u1', 'country', 1000, 1000)`).run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/genres/country/unblock', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM user_blocked_genres WHERE user_id = ? AND genre = ?').bind('u1', 'country').first();
    expect(row).toBeNull();
  });

  it('never touches another user\'s block on the same genre', async () => {
    await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp2', createdAt: 1000, updatedAt: 1000 });
    await env.DB.prepare(`INSERT INTO user_blocked_genres (id, user_id, genre, created_at, updated_at) VALUES ('b1', 'u2', 'country', 1000, 1000)`).run();
    const cookie = await cookieFor('u1');

    await worker.fetch(
      new Request('http://localhost/api/genres/country/unblock', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );

    const row = await env.DB.prepare('SELECT * FROM user_blocked_genres WHERE user_id = ? AND genre = ?').bind('u2', 'country').first();
    expect(row).toBeTruthy();
  });
});
