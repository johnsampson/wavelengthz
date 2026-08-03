import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM users;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
});

async function sessionCookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

describe('POST /api/onboarding', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/onboarding', { method: 'POST' }), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('rejects and writes nothing when date_of_birth is missing', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_date_of_birth');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects and writes nothing when date_of_birth is unparseable garbage', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: 'not-a-date', location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_date_of_birth');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects and writes nothing when date_of_birth is a number', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: 12345, location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_date_of_birth');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects and writes nothing when date_of_birth is a boolean', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: true, location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_date_of_birth');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('rejects and writes nothing when the user is under 18', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: '2015-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.error).toBe('underage');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('saves onboarding fields and marks age-verified for an adult', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bio: 'hi', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, max_distance_km: 40 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).not.toBeNull();
    expect(row.age_verified_at).not.toBeNull();
    expect(row.bio).toBe('hi');
    expect(row.max_distance_km).toBe(40);
  });
});
