import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { hasCompleteProfile, photoCountFor, MIN_BIO_LENGTH } from '../../src/lib/messagingGate';
import { insertTestUser } from '../helpers/createUser';

describe('hasCompleteProfile', () => {
  it('is false with no bio and no photos', () => {
    expect(hasCompleteProfile({ bio: null }, 0)).toBe(false);
  });

  it('is false with a photo but a bio under the minimum length', () => {
    expect(hasCompleteProfile({ bio: 'too short' }, 1)).toBe(false);
  });

  it('is false with a long enough bio but zero photos', () => {
    expect(hasCompleteProfile({ bio: 'a'.repeat(MIN_BIO_LENGTH) }, 0)).toBe(false);
  });

  it('is true with a bio at exactly the minimum length and at least one photo', () => {
    expect(hasCompleteProfile({ bio: 'a'.repeat(MIN_BIO_LENGTH) }, 1)).toBe(true);
  });

  it('trims whitespace before measuring bio length -- padding does not count', () => {
    const padded = ' '.repeat(50) + 'short' + ' '.repeat(50);
    expect(hasCompleteProfile({ bio: padded }, 1)).toBe(false);
  });
});

describe('photoCountFor', () => {
  beforeAll(async () => {
    await applySchema(env.DB);
  });

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM user_photos; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', createdAt: 1000, updatedAt: 1000 });
  });

  it('returns 0 for a user with no photos', async () => {
    expect(await photoCountFor(env.DB, 'u1')).toBe(0);
  });

  it('counts a user\'s own photos only', async () => {
    await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp2', createdAt: 1000, updatedAt: 1000 });
    await env.DB.prepare(`INSERT INTO user_photos (id, user_id, r2_key, position, created_at, updated_at) VALUES ('p1', 'u1', 'k1', 0, 1000, 1000)`).run();
    await env.DB.prepare(`INSERT INTO user_photos (id, user_id, r2_key, position, created_at, updated_at) VALUES ('p2', 'u1', 'k2', 1, 1000, 1000)`).run();
    await env.DB.prepare(`INSERT INTO user_photos (id, user_id, r2_key, position, created_at, updated_at) VALUES ('p3', 'u2', 'k3', 0, 1000, 1000)`).run();

    expect(await photoCountFor(env.DB, 'u1')).toBe(2);
  });
});
