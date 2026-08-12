import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  // PHONE_VERIFY_LIMIT (5/min, src/index.ts) is keyed by IP+time-bucket in
  // RATE_LIMIT_KV, which -- unlike D1 -- isn't reset per test on its own;
  // this file alone makes more than 5 calls to /api/phone/verify/start.
  const rateLimitKeys = await env.RATE_LIMIT_KV.list({ prefix: 'ratelimit:phone-verify:' });
  await Promise.all(rateLimitKeys.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));

  await env.DB.exec('DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', createdAt: 1000, updatedAt: 1000 });
  await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp2', createdAt: 1000, updatedAt: 1000 });
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

function stubTwilio({ lineType = 'mobile', lookupValid = true, verifyStatus = 'approved' }: { lineType?: string | null; lookupValid?: boolean; verifyStatus?: string } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes('lookups.twilio.com')) {
        return new Response(
          JSON.stringify({ valid: lookupValid, phone_number: '+15108675310', line_type_intelligence: lineType ? { type: lineType } : null }),
          { status: 200 }
        );
      }
      if (url.includes('/Verifications') && !url.includes('Check')) {
        return new Response(JSON.stringify({ status: 'pending' }), { status: 201 });
      }
      if (url.includes('/VerificationCheck')) {
        return new Response(JSON.stringify({ status: verifyStatus }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    })
  );
  return calls;
}

describe('POST /api/phone/verify/start', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
    vi.unstubAllGlobals();
  });

  it('rejects a malformed phone number before ever calling Twilio', async () => {
    const calls = stubTwilio();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/start', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '5108675310' }), // missing '+'
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_phone_number');
    expect(calls.length).toBe(0);
    vi.unstubAllGlobals();
  });

  it('rejects a VOIP number without ever starting a Verify (no SMS sent/billed)', async () => {
    const calls = stubTwilio({ lineType: 'voip' });
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/start', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('voip_not_allowed');
    expect(calls.some((u) => u.includes('/Verifications'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects a number Twilio itself reports as invalid', async () => {
    stubTwilio({ lookupValid: false });
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/start', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_phone_number');
    vi.unstubAllGlobals();
  });

  it('starts a verification for a real mobile number', async () => {
    const calls = stubTwilio({ lineType: 'mobile' });
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/start', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.ok).toBe(true);
    expect(calls.some((u) => u.includes('/Verifications'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('allows a landline (only voip is blocked)', async () => {
    stubTwilio({ lineType: 'landline' });
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/start', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    vi.unstubAllGlobals();
  });

  it('returns 502 (not a crash) when the Twilio Lookup call itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/start', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(502);
    vi.unstubAllGlobals();
  });
});

describe('POST /api/phone/verify/check', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310', code: '123456' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it('rejects a wrong code and writes nothing', async () => {
    stubTwilio({ verifyStatus: 'pending' });
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/check', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310', code: '000000' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe('invalid_code');
    const row = await env.DB.prepare('SELECT phone_number, phone_verified_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.phone_number).toBeNull();
    expect(row.phone_verified_at).toBeNull();
    vi.unstubAllGlobals();
  });

  it('verifies the phone on a correct code', async () => {
    stubTwilio({ verifyStatus: 'approved' });
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/check', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310', code: '123456' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT phone_number, phone_verified_at, updated_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.phone_number).toBe('+15108675310');
    expect(row.phone_verified_at).not.toBeNull();
    expect(row.updated_at).not.toBe(1000); // touched, not left at insert-time (CLAUDE.md's schema convention)
    vi.unstubAllGlobals();
  });

  it('rejects a phone number already verified on another account', async () => {
    await env.DB.prepare('UPDATE users SET phone_number = ?, phone_verified_at = ? WHERE id = ?').bind('+15108675310', 1000, 'u2').run();
    stubTwilio({ verifyStatus: 'approved' });
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/check', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310', code: '123456' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.error).toBe('phone_already_verified');
    const row = await env.DB.prepare('SELECT phone_number FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.phone_number).toBeNull();
    vi.unstubAllGlobals();
  });

  it('allows re-verifying the same number already on the caller\'s own account', async () => {
    await env.DB.prepare('UPDATE users SET phone_number = ?, phone_verified_at = ? WHERE id = ?').bind('+15108675310', 1000, 'u1').run();
    stubTwilio({ verifyStatus: 'approved' });
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/check', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310', code: '123456' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    vi.unstubAllGlobals();
  });

  it('returns 502 (not a crash) when the Twilio check call itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/check', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310', code: '123456' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(502);
    vi.unstubAllGlobals();
  });

  it('rejects a blank code', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/phone/verify/check', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15108675310', code: '' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
  });
});
