import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { insertTestUser } from '../helpers/createUser';
import {
  INVITE_CODES_PER_MEMBER,
  generateInviteCode,
  isInviteOnly,
  claimInviteCode,
  grantInviteCodes,
  lookupInviteCode,
} from '../../src/lib/inviteCodes';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM invite_codes; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
});

describe('generateInviteCode', () => {
  it('is 8 characters, uppercase/digits only, excluding 0/O/1/I', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[A-Z2-9]+$/);
      expect(code).not.toMatch(/[0O1I]/);
    }
  });

  it('does not produce the same code twice in a reasonably large sample', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateInviteCode()));
    expect(codes.size).toBe(500);
  });
});

describe('isInviteOnly', () => {
  it('is off for an empty string (the default)', () => {
    expect(isInviteOnly({ INVITE_ONLY: '' })).toBe(false);
  });

  it('is on for any non-empty value', () => {
    expect(isInviteOnly({ INVITE_ONLY: 'true' })).toBe(true);
    expect(isInviteOnly({ INVITE_ONLY: '1' })).toBe(true);
  });
});

describe('claimInviteCode', () => {
  it('claims an unredeemed code and stamps the redeemer', async () => {
    await env.DB.prepare(
      `INSERT INTO invite_codes (id, code, target_gender, created_at, updated_at) VALUES ('ic1', 'ABCD1234', 'female', 1000, 1000)`
    ).run();
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1' });

    const result = await claimInviteCode(env.DB, 'ABCD1234', 'u1', 2000);

    expect(result).toEqual({ claimed: true, codeId: 'ic1' });
    const row = await env.DB.prepare('SELECT redeemed_by_user_id, redeemed_at FROM invite_codes WHERE id = ?').bind('ic1').first<any>();
    expect(row.redeemed_by_user_id).toBe('u1');
    expect(row.redeemed_at).toBe(2000);
  });

  it('rejects an unknown code', async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1' });
    const result = await claimInviteCode(env.DB, 'NOSUCHCODE', 'u1', 2000);
    expect(result).toEqual({ claimed: false, codeId: null });
  });

  it('rejects a code someone else already redeemed', async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1' });
    await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp2' });
    await env.DB.prepare(
      `INSERT INTO invite_codes (id, code, target_gender, redeemed_by_user_id, redeemed_at, created_at, updated_at)
       VALUES ('ic1', 'ABCD1234', 'female', 'u2', 1500, 1000, 1500)`
    ).run();

    const result = await claimInviteCode(env.DB, 'ABCD1234', 'u1', 2000);

    expect(result).toEqual({ claimed: false, codeId: null });
    const row = await env.DB.prepare('SELECT redeemed_by_user_id FROM invite_codes WHERE id = ?').bind('ic1').first<any>();
    expect(row.redeemed_by_user_id).toBe('u2'); // untouched
  });
});

describe('grantInviteCodes', () => {
  it('grants INVITE_CODES_PER_MEMBER codes, each targeting the opposite gender', async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1' });

    await grantInviteCodes(env.DB, 'u1', 'female', 1000);

    const rows = await env.DB.prepare('SELECT * FROM invite_codes WHERE created_by_user_id = ?').bind('u1').all<any>();
    expect(rows.results).toHaveLength(INVITE_CODES_PER_MEMBER);
    for (const row of rows.results) {
      expect(row.target_gender).toBe('male');
      expect(row.redeemed_by_user_id).toBeNull();
      expect(row.code).toHaveLength(8);
    }
    // Every code from one grant is distinct.
    expect(new Set(rows.results.map((r: any) => r.code)).size).toBe(INVITE_CODES_PER_MEMBER);
  });

  it('targets female for a male member', async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1' });
    await grantInviteCodes(env.DB, 'u1', 'male', 1000);
    const rows = await env.DB.prepare('SELECT target_gender FROM invite_codes WHERE created_by_user_id = ?').bind('u1').all<any>();
    expect(rows.results.every((r: any) => r.target_gender === 'female')).toBe(true);
  });
});

describe('lookupInviteCode', () => {
  it('reports invalid for an unknown code', async () => {
    expect(await lookupInviteCode(env.DB, 'NOSUCHCODE')).toEqual({ valid: false });
  });

  it('reports invalid for an already-redeemed code', async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1' });
    await env.DB.prepare(
      `INSERT INTO invite_codes (id, code, target_gender, redeemed_by_user_id, redeemed_at, created_at, updated_at)
       VALUES ('ic1', 'ABCD1234', 'female', 'u1', 1500, 1000, 1500)`
    ).run();
    expect(await lookupInviteCode(env.DB, 'ABCD1234')).toEqual({ valid: false });
  });

  it("returns the inviter's display name and target gender for a valid code, never their email", async () => {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', displayName: 'Jordan', email: 'jordan@example.com' });
    await env.DB.prepare(
      `INSERT INTO invite_codes (id, code, created_by_user_id, target_gender, created_at, updated_at) VALUES ('ic1', 'ABCD1234', 'u1', 'female', 1000, 1000)`
    ).run();

    const result = await lookupInviteCode(env.DB, 'ABCD1234');

    expect(result).toEqual({ valid: true, inviterName: 'Jordan', targetGender: 'female' });
    expect(JSON.stringify(result)).not.toContain('jordan@example.com');
  });

  it('reports a founding (admin-issued) code with no inviter name', async () => {
    await env.DB.prepare(
      `INSERT INTO invite_codes (id, code, target_gender, created_at, updated_at) VALUES ('ic1', 'ABCD1234', NULL, 1000, 1000)`
    ).run();
    const result = await lookupInviteCode(env.DB, 'ABCD1234');
    expect(result).toEqual({ valid: true, inviterName: null, targetGender: null });
  });
});
