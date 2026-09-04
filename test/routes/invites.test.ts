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
    'DELETE FROM invite_codes; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

describe('GET /api/invites/:code', () => {
  it('is public -- no session required', async () => {
    await env.DB.prepare(
      `INSERT INTO invite_codes (id, code, target_gender, created_at, updated_at) VALUES ('ic1', 'ABCD1234', 'female', 1000, 1000)`
    ).run();

    const res = await worker.fetch(new Request('http://localhost/api/invites/ABCD1234'), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(await res.json<any>()).toEqual({ valid: true, inviterName: null, targetGender: 'female' });
  });

  it('reports invalid for an unknown code, still 200', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/invites/NOSUCHCODE'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await res.json<any>()).toEqual({ valid: false });
  });
});

describe('GET /api/me/invites', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/me/invites'), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it("lists codes I've issued, marking which are redeemed and by whom", async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1' });
    await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp2', displayName: 'Sam' });
    await env.DB.prepare(
      `INSERT INTO invite_codes (id, code, created_by_user_id, target_gender, created_at, updated_at) VALUES ('ic1', 'ABCD1234', 'u1', 'female', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO invite_codes (id, code, created_by_user_id, target_gender, redeemed_by_user_id, redeemed_at, created_at, updated_at)
       VALUES ('ic2', 'EFGH5678', 'u1', 'female', 'u2', 1500, 1000, 1500)`
    ).run();
    // A code issued by someone else -- must not show up in u1's list.
    await env.DB.prepare(
      `INSERT INTO invite_codes (id, code, created_by_user_id, target_gender, created_at, updated_at) VALUES ('ic3', 'IJKL9012', 'u2', 'male', 1000, 1000)`
    ).run();

    const res = await worker.fetch(new Request('http://localhost/api/me/invites', { headers: { Cookie: await cookieFor('u1') } }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.invites).toHaveLength(2);
    expect(body.invites).toEqual(
      expect.arrayContaining([
        { code: 'ABCD1234', targetGender: 'female', redeemed: false, redeemedByName: null },
        { code: 'EFGH5678', targetGender: 'female', redeemed: true, redeemedByName: 'Sam' },
      ])
    );
    expect(body.canMintUnlimited).toBe(false); // u1 isn't one of the allowlisted admin emails
  });

  // Issue #173 (Round 8): the three allowlisted invite-admin accounts see
  // canMintUnlimited: true so the frontend knows to show the mint panel.
  it('reports canMintUnlimited: true for an allowlisted invite-admin email', async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', email: 'connect@wavelengthz.com' });

    const res = await worker.fetch(new Request('http://localhost/api/me/invites', { headers: { Cookie: await cookieFor('u1') } }), env, {} as ExecutionContext);

    expect((await res.json<any>()).canMintUnlimited).toBe(true);
  });

  // Issue #127: "did we take the share/invite live? I don't see it."
  // grantInviteCodes only ever fires on the onboarded_at NULL -> set
  // transition (src/routes/onboarding.ts) -- an account that onboarded
  // before this feature existed has zero rows and no future event that
  // would ever grant it any otherwise. This endpoint self-heals that on
  // first visit instead.
  it('grants invite codes on first visit to an already-onboarded user who has none', async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', gender: 'male', onboardedAt: 1000 });

    const res = await worker.fetch(new Request('http://localhost/api/me/invites', { headers: { Cookie: await cookieFor('u1') } }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.invites).toHaveLength(2);
    // The self-balancing mechanism: a declared 'male' member's codes only
    // work for 'female' (src/lib/inviteCodes.ts's grantInviteCodes).
    for (const invite of body.invites) {
      expect(invite.targetGender).toBe('female');
      expect(invite.redeemed).toBe(false);
    }
    const rows = await env.DB.prepare('SELECT created_by_user_id FROM invite_codes WHERE created_by_user_id = ?').bind('u1').all<any>();
    expect(rows.results).toHaveLength(2);
  });

  it('does not grant a second batch on a repeat visit', async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', gender: 'female', onboardedAt: 1000 });

    await worker.fetch(new Request('http://localhost/api/me/invites', { headers: { Cookie: await cookieFor('u1') } }), env, {} as ExecutionContext);
    const res = await worker.fetch(new Request('http://localhost/api/me/invites', { headers: { Cookie: await cookieFor('u1') } }), env, {} as ExecutionContext);

    const body = await res.json<any>();
    expect(body.invites).toHaveLength(2); // still 2, not 4
  });

  it('does not grant to a user who has not finished onboarding yet', async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1' }); // onboardedAt/gender both null by default

    const res = await worker.fetch(new Request('http://localhost/api/me/invites', { headers: { Cookie: await cookieFor('u1') } }), env, {} as ExecutionContext);

    const body = await res.json<any>();
    expect(body.invites).toHaveLength(0);
  });
});

describe('POST /api/me/invites/mint', () => {
  async function mint(cookie: string, body: any) {
    return worker.fetch(
      new Request('http://localhost/api/me/invites/mint', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      {} as ExecutionContext
    );
  }

  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/me/invites/mint', { method: 'POST', body: JSON.stringify({ count: 5 }) }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for a logged-in user who is not an allowlisted invite admin', async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', email: 'someone@example.com' });
    const res = await mint(await cookieFor('u1'), { count: 5 });
    expect(res.status).toBe(403);
  });

  it('mints N codes with no gender lock, credited to the admin, for an allowlisted email', async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', email: 'john@johnasampson.com' });

    const res = await mint(await cookieFor('u1'), { count: 5 });

    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.codes).toHaveLength(5);
    expect(new Set(body.codes).size).toBe(5); // all distinct

    const rows = await env.DB.prepare('SELECT created_by_user_id, target_gender, redeemed_by_user_id FROM invite_codes WHERE created_by_user_id = ?')
      .bind('u1')
      .all<any>();
    expect(rows.results).toHaveLength(5);
    for (const row of rows.results) {
      expect(row.target_gender).toBeNull();
      expect(row.redeemed_by_user_id).toBeNull();
    }
  });

  it('rejects an invalid or out-of-range count', async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', email: 'connect@wavelengthz.com' });
    const cookie = await cookieFor('u1');
    expect((await mint(cookie, { count: 0 })).status).toBe(400);
    expect((await mint(cookie, { count: -1 })).status).toBe(400);
    expect((await mint(cookie, {})).status).toBe(400);
    expect((await mint(cookie, { count: 501 })).status).toBe(400);
  });
});

describe('POST /internal/invites/generate', () => {
  async function generate(body: any, secret = 'test-seed-secret') {
    return worker.fetch(
      new Request('http://localhost/internal/invites/generate', {
        method: 'POST',
        headers: { 'X-Seed-Secret': secret, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      {} as ExecutionContext
    );
  }

  it('rejects a wrong or missing X-Seed-Secret', async () => {
    expect((await generate({ count: 3 }, 'wrong-secret')).status).toBe(403);
    const noHeaderRes = await worker.fetch(
      new Request('http://localhost/internal/invites/generate', { method: 'POST', body: JSON.stringify({ count: 3 }) }),
      env,
      {} as ExecutionContext
    );
    expect(noHeaderRes.status).toBe(403);
  });

  it('generates founding codes with no creator, target gender as requested', async () => {
    const res = await generate({ count: 3, targetGender: 'female' });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.codes).toHaveLength(3);

    const rows = await env.DB.prepare('SELECT created_by_user_id, target_gender FROM invite_codes').all<any>();
    expect(rows.results).toHaveLength(3);
    for (const row of rows.results) {
      expect(row.created_by_user_id).toBeNull();
      expect(row.target_gender).toBe('female');
    }
  });

  it('allows a null target gender (usable by either)', async () => {
    const res = await generate({ count: 1 });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT target_gender FROM invite_codes').first<any>();
    expect(row.target_gender).toBeNull();
  });

  it('rejects an invalid count', async () => {
    expect((await generate({ count: 0 })).status).toBe(400);
    expect((await generate({ count: -1 })).status).toBe(400);
    expect((await generate({})).status).toBe(400);
  });

  it('rejects an invalid target gender', async () => {
    const res = await generate({ count: 1, targetGender: 'nonbinary-not-a-real-option' });
    expect(res.status).toBe(400);
  });
});
