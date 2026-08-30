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
  await env.DB.exec('DELETE FROM analytics_events; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
  const rateLimitKeys = await env.RATE_LIMIT_KV.list();
  await Promise.all(rateLimitKeys.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

describe('POST /api/analytics/event', () => {
  it('records an anonymous event when no session cookie is present', async () => {
    const req = new Request('http://localhost/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'session_start' }),
    });

    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM analytics_events').first<any>();
    expect(row.user_id).toBeNull();
    expect(row.event_type).toBe('session_start');
  });

  it('attaches the real user_id when a valid session cookie is present', async () => {
    await insertTestUser(env.DB, { id: 'u1' });
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ eventType: 'song_play', metadata: { trackId: 't1' } }),
    });

    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM analytics_events').first<any>();
    expect(row.user_id).toBe('u1');
    expect(row.event_type).toBe('song_play');
    expect(JSON.parse(row.metadata)).toEqual({ trackId: 't1' });
  });

  it('rejects an event_type outside the known set, without inserting a row', async () => {
    const req = new Request('http://localhost/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'literally_anything' }),
    });

    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) as c FROM analytics_events').first<{ c: number }>()).toEqual({ c: 0 });
  });

  it('rejects a non-JSON body with 400 rather than throwing', async () => {
    const req = new Request('http://localhost/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(400);
  });

  it('rejects metadata over the size cap, without inserting a row', async () => {
    const req = new Request('http://localhost/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'session_start', metadata: { blob: 'x'.repeat(3000) } }),
    });

    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) as c FROM analytics_events').first<{ c: number }>()).toEqual({ c: 0 });
  });
});
