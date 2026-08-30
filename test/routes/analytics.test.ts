import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
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

// Issue #168 (part of the 250K-users strategy discussion).
describe('POST /api/analytics/event -- GA4 forwarding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not call GA4 when GA4_MEASUREMENT_ID/GA4_API_SECRET are unset (the default)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const req = new Request('http://localhost/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'session_start', clientId: 'c1', sessionId: 's1' }),
    });

    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards to GA4 with the same event data once GA4 secrets are configured', async () => {
    const fetchMock = vi.fn(async (url: string, options?: any) => new Response('', { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await insertTestUser(env.DB, { id: 'u1' });
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ eventType: 'song_play', metadata: { spotifyId: 'sp1' }, clientId: 'c1', sessionId: 's1' }),
    });
    const ga4Env = { ...env, GA4_MEASUREMENT_ID: 'G-TEST123', GA4_API_SECRET: 'secret123' };

    const res = await worker.fetch(req, ga4Env, ctx);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.google-analytics.com/mp/collect?measurement_id=G-TEST123&api_secret=secret123');
    const body = JSON.parse((options as any).body);
    expect(body.client_id).toBe('c1');
    expect(body.user_id).toBe('u1');
    expect(body.events[0].name).toBe('song_play');
    expect(body.events[0].params).toEqual({ spotifyId: 'sp1', session_id: 's1', engagement_time_msec: 1 });
  });

  it('does not call GA4 when clientId is absent from the request, even with secrets configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const req = new Request('http://localhost/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'session_start' }),
    });
    const ga4Env = { ...env, GA4_MEASUREMENT_ID: 'G-TEST123', GA4_API_SECRET: 'secret123' };

    const res = await worker.fetch(req, ga4Env, ctx);

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
