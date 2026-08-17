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
  await env.DB.exec(
    'DELETE FROM track_plays; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp-u1', createdAt: 1000, updatedAt: 1000 });
  await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp-u2', createdAt: 1000, updatedAt: 1000 });
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

async function startPlay(cookie: string, body: any) {
  const res = await worker.fetch(
    new Request('http://localhost/api/plays', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    {} as ExecutionContext
  );
  return { status: res.status, body: res.ok ? await res.json<any>() : null };
}

async function markCounted(cookie: string, playId: string) {
  const res = await worker.fetch(
    new Request(`http://localhost/api/plays/${playId}/counted`, { method: 'POST', headers: { Cookie: cookie } }),
    env,
    {} as ExecutionContext
  );
  return { status: res.status, body: res.ok ? await res.json<any>() : null };
}

describe('POST /api/plays', () => {
  it('requires a session', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/plays', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spotifyTrackId: 'sp-t1' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it('records a play and returns its id', async () => {
    const cookie = await cookieFor('u1');
    const { status, body } = await startPlay(cookie, { spotifyTrackId: 'sp-t1', trackId: 't1', startPositionMs: 36000 });

    expect(status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM track_plays WHERE id = ?').bind(body.playId).first<any>();
    expect(row.user_id).toBe('u1');
    expect(row.spotify_track_id).toBe('sp-t1');
    expect(row.track_id).toBe('t1');
    expect(row.start_position_ms).toBe(36000);
    // The whole point: a fresh play is uncounted until it earns it.
    expect(row.reached_threshold_at).toBeNull();
  });

  it('accepts a play for a track with no catalog row -- a deck anthem has none', async () => {
    const cookie = await cookieFor('u1');
    const { body } = await startPlay(cookie, { spotifyTrackId: 'sp-anthem' });

    const row = await env.DB.prepare('SELECT * FROM track_plays WHERE id = ?').bind(body.playId).first<any>();
    expect(row.track_id).toBeNull();
    expect(row.start_position_ms).toBe(0);
  });

  it('rejects a request with no spotify track id', async () => {
    const cookie = await cookieFor('u1');
    expect((await startPlay(cookie, {})).status).toBe(400);
    expect((await startPlay(cookie, { spotifyTrackId: '   ' })).status).toBe(400);
  });

  it('clamps a nonsense start position rather than failing the play', async () => {
    const cookie = await cookieFor('u1');
    for (const bad of [-5000, NaN, 'abc', null]) {
      const { status, body } = await startPlay(cookie, { spotifyTrackId: 'sp-t1', startPositionMs: bad });
      expect(status).toBe(200);
      const row = await env.DB.prepare('SELECT start_position_ms FROM track_plays WHERE id = ?').bind(body.playId).first<any>();
      expect(row.start_position_ms).toBe(0);
    }
  });
});

describe('POST /api/plays/:id/counted', () => {
  it('marks a play as having reached the threshold', async () => {
    const cookie = await cookieFor('u1');
    const { body } = await startPlay(cookie, { spotifyTrackId: 'sp-t1' });

    const { status, body: counted } = await markCounted(cookie, body.playId);

    expect(status).toBe(200);
    expect(counted.updated).toBe(true);
    const row = await env.DB.prepare('SELECT reached_threshold_at FROM track_plays WHERE id = ?').bind(body.playId).first<any>();
    expect(row.reached_threshold_at).toBeGreaterThan(0);
  });

  it('is idempotent -- a repeat call keeps the first crossing timestamp', async () => {
    const cookie = await cookieFor('u1');
    const { body } = await startPlay(cookie, { spotifyTrackId: 'sp-t1' });
    await markCounted(cookie, body.playId);
    const first = await env.DB.prepare('SELECT reached_threshold_at FROM track_plays WHERE id = ?').bind(body.playId).first<any>();

    const second = await markCounted(cookie, body.playId);

    expect(second.status).toBe(200);
    expect(second.body.updated).toBe(false); // nothing changed the second time
    const after = await env.DB.prepare('SELECT reached_threshold_at FROM track_plays WHERE id = ?').bind(body.playId).first<any>();
    expect(after.reached_threshold_at).toBe(first.reached_threshold_at);
  });

  it('cannot mark another user\'s play', async () => {
    const c1 = await cookieFor('u1');
    const c2 = await cookieFor('u2');
    const { body } = await startPlay(c1, { spotifyTrackId: 'sp-t1' });

    const res = await markCounted(c2, body.playId);

    expect(res.body.updated).toBe(false);
    const row = await env.DB.prepare('SELECT reached_threshold_at FROM track_plays WHERE id = ?').bind(body.playId).first<any>();
    expect(row.reached_threshold_at).toBeNull();
  });

  it('does not error on an unknown play id -- telemetry must never disturb playback', async () => {
    const cookie = await cookieFor('u1');
    const res = await markCounted(cookie, 'no-such-play');
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
  });

  it('requires a session', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/plays/whatever/counted', { method: 'POST' }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });
});

describe('the ratio this table exists to answer', () => {
  it('distinguishes counted from abandoned plays', async () => {
    const cookie = await cookieFor('u1');
    const a = await startPlay(cookie, { spotifyTrackId: 'sp-a' });
    const b = await startPlay(cookie, { spotifyTrackId: 'sp-b' });
    await startPlay(cookie, { spotifyTrackId: 'sp-c' }); // abandoned early
    await markCounted(cookie, a.body.playId);
    await markCounted(cookie, b.body.playId);

    const stats = await env.DB.prepare(
      `SELECT COUNT(*) AS started, SUM(CASE WHEN reached_threshold_at IS NOT NULL THEN 1 ELSE 0 END) AS counted
       FROM track_plays WHERE user_id = ?`
    )
      .bind('u1')
      .first<{ started: number; counted: number }>();

    expect(stats).toEqual({ started: 3, counted: 2 });
  });
});
