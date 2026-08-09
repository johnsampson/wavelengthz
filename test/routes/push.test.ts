import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM push_subscriptions; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1' });
  await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp2' });
});

describe('GET /api/push/vapid-public-key', () => {
  it('returns the public key with no auth required', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/push/vapid-public-key'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.publicKey).toBe(env.VAPID_PUBLIC_KEY);
  });
});

describe('POST /api/push/subscribe', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }) }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it('inserts a subscription for the current user', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/push/subscribe', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').bind('https://push.example/x').first<any>();
    expect(row.user_id).toBe('u1');
    expect(row.p256dh).toBe('p');
    expect(row.auth).toBe('a');
  });

  it('upserts by endpoint instead of creating a duplicate row', async () => {
    const cookie = await cookieFor('u1');
    const subscribe = () =>
      worker.fetch(
        new Request('http://localhost/api/push/subscribe', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: 'https://push.example/x', keys: { p256dh: 'p2', auth: 'a2' } }),
        }),
        env,
        {} as ExecutionContext
      );
    await subscribe();
    await subscribe();
    const rows = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').bind('https://push.example/x').all<any>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0].p256dh).toBe('p2');
  });
});

describe('POST /api/push/unsubscribe', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: 'https://push.example/x' }) }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it('deletes only the current user\'s matching subscription', async () => {
    await env.DB.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('s1', 'u1', 'https://push.example/x', 'p', 'a', ?)`).bind(Date.now()).run();
    await env.DB.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('s2', 'u2', 'https://push.example/y', 'p', 'a', ?)`).bind(Date.now()).run();

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/push/unsubscribe', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://push.example/x' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    expect(await env.DB.prepare('SELECT * FROM push_subscriptions WHERE id = ?').bind('s1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM push_subscriptions WHERE id = ?').bind('s2').first()).not.toBeNull();
  });

  it('does not delete another user\'s subscription at the same endpoint mismatch attempt', async () => {
    await env.DB.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('s2', 'u2', 'https://push.example/y', 'p', 'a', ?)`).bind(Date.now()).run();

    const cookie = await cookieFor('u1');
    await worker.fetch(
      new Request('http://localhost/api/push/unsubscribe', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://push.example/y' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(await env.DB.prepare('SELECT * FROM push_subscriptions WHERE id = ?').bind('s2').first()).not.toBeNull();
  });
});
