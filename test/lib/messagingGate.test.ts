import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import {
  hasCompleteProfile,
  messagingRequirements,
  photoCountFor,
  artistsActedCountFor,
  MIN_BIO_LENGTH,
  MIN_PHOTOS,
  MIN_ARTISTS_ACTED,
} from '../../src/lib/messagingGate';
import { insertTestUser } from '../helpers/createUser';

const COMPLETE_BIO = 'a'.repeat(MIN_BIO_LENGTH);
const VERIFIED_AT = 1000;

beforeAll(async () => {
  await applySchema(env.DB);
});

// Issue #173 (Round 8): guidelines/safety-tips acknowledgement, on top of
// the pre-existing bio/photos/artistsActed/phone requirements. NOT_ACKED
// unnamed here -- callers below just pass null/VERIFIED_AT-style timestamps
// inline, mirroring how phone_verified_at already reads in this file.
const UNMET = { bio: null, phone_verified_at: null, guidelines_acknowledged_at: null, safety_tips_acknowledged_at: null };
const MET = { bio: COMPLETE_BIO, phone_verified_at: VERIFIED_AT, guidelines_acknowledged_at: VERIFIED_AT, safety_tips_acknowledged_at: VERIFIED_AT };

describe('messagingRequirements', () => {
  it('flags every requirement independently -- an all-null/zero user meets none of them', () => {
    const r = messagingRequirements(UNMET, 0, 0);
    expect(r).toEqual({ bio: false, photos: false, artistsActed: false, phone: false, guidelines: false, safetyTips: false });
  });

  it('flags each requirement true once its own threshold is met, independent of the others', () => {
    const r = messagingRequirements(MET, MIN_PHOTOS, MIN_ARTISTS_ACTED);
    expect(r).toEqual({ bio: true, photos: true, artistsActed: true, phone: true, guidelines: true, safetyTips: true });
  });

  it('bio is false under the minimum length and true at exactly the minimum', () => {
    expect(messagingRequirements({ ...UNMET, bio: 'too short' }, 0, 0).bio).toBe(false);
    expect(messagingRequirements({ ...UNMET, bio: COMPLETE_BIO }, 0, 0).bio).toBe(true);
  });

  it('trims whitespace before measuring bio length -- padding does not count', () => {
    const padded = ' '.repeat(50) + 'short' + ' '.repeat(50);
    expect(messagingRequirements({ ...UNMET, bio: padded }, 0, 0).bio).toBe(false);
  });

  it('photos is false below MIN_PHOTOS and true at exactly MIN_PHOTOS', () => {
    expect(messagingRequirements(UNMET, MIN_PHOTOS - 1, 0).photos).toBe(false);
    expect(messagingRequirements(UNMET, MIN_PHOTOS, 0).photos).toBe(true);
  });

  it('artistsActed is false below MIN_ARTISTS_ACTED and true at exactly MIN_ARTISTS_ACTED', () => {
    expect(messagingRequirements(UNMET, 0, MIN_ARTISTS_ACTED - 1).artistsActed).toBe(false);
    expect(messagingRequirements(UNMET, 0, MIN_ARTISTS_ACTED).artistsActed).toBe(true);
  });

  it('phone is false when phone_verified_at is null, true otherwise', () => {
    expect(messagingRequirements(UNMET, 0, 0).phone).toBe(false);
    expect(messagingRequirements({ ...UNMET, phone_verified_at: VERIFIED_AT }, 0, 0).phone).toBe(true);
  });

  it('guidelines is false when guidelines_acknowledged_at is null, true otherwise', () => {
    expect(messagingRequirements(UNMET, 0, 0).guidelines).toBe(false);
    expect(messagingRequirements({ ...UNMET, guidelines_acknowledged_at: VERIFIED_AT }, 0, 0).guidelines).toBe(true);
  });

  it('safetyTips is false when safety_tips_acknowledged_at is null, true otherwise -- independent of guidelines', () => {
    expect(messagingRequirements(UNMET, 0, 0).safetyTips).toBe(false);
    expect(messagingRequirements({ ...UNMET, safety_tips_acknowledged_at: VERIFIED_AT }, 0, 0).safetyTips).toBe(true);
    // Acknowledging one does not imply the other.
    const guidelinesOnly = messagingRequirements({ ...UNMET, guidelines_acknowledged_at: VERIFIED_AT }, 0, 0);
    expect(guidelinesOnly.guidelines).toBe(true);
    expect(guidelinesOnly.safetyTips).toBe(false);
  });
});

describe('hasCompleteProfile', () => {
  it('is false when only some requirements are met', () => {
    // Bio and photos met, artists acted on, phone, and both acknowledgements are not.
    expect(hasCompleteProfile({ ...UNMET, bio: COMPLETE_BIO }, MIN_PHOTOS, 0)).toBe(false);
    // Everything but phone verification and the two acknowledgements.
    expect(hasCompleteProfile({ ...UNMET, bio: COMPLETE_BIO }, MIN_PHOTOS, MIN_ARTISTS_ACTED)).toBe(false);
  });

  it('is false when every other requirement is met but only one of the two acknowledgements is', () => {
    expect(hasCompleteProfile({ ...MET, safety_tips_acknowledged_at: null }, MIN_PHOTOS, MIN_ARTISTS_ACTED)).toBe(false);
    expect(hasCompleteProfile({ ...MET, guidelines_acknowledged_at: null }, MIN_PHOTOS, MIN_ARTISTS_ACTED)).toBe(false);
  });

  it('is true only once every requirement, including both acknowledgements, is met', () => {
    expect(hasCompleteProfile(MET, MIN_PHOTOS, MIN_ARTISTS_ACTED)).toBe(true);
  });
});

describe('photoCountFor', () => {
  beforeEach(async () => {
    await env.DB.exec(
      'DELETE FROM user_photos; DELETE FROM music_swipes; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
    );
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

describe('artistsActedCountFor', () => {
  beforeEach(async () => {
    await env.DB.exec(
      'DELETE FROM user_photos; DELETE FROM music_swipes; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
    );
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', createdAt: 1000, updatedAt: 1000 });
  });

  // music_swipes.item_id carries no FK to artists/tracks (it's a plain TEXT
  // column, see migrations/0001), so fabricated ids are fine here -- this
  // is purely a COUNT query, never a join.
  async function insertSwipe(userId: string, id: string, itemType: 'artist' | 'track', direction: 'left' | 'right' | 'skip') {
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1000, 1000)`
    )
      .bind(id, userId, itemType, `item-${id}`, direction)
      .run();
  }

  it('returns 0 for a user with no swiped artists', async () => {
    expect(await artistsActedCountFor(env.DB, 'u1')).toBe(0);
  });

  it('counts a liked, a passed, and a skipped artist alike -- but not a track swipe', async () => {
    await insertSwipe('u1', 's1', 'artist', 'right');
    await insertSwipe('u1', 's2', 'artist', 'left');
    await insertSwipe('u1', 's3', 'artist', 'skip');
    await insertSwipe('u1', 's4', 'track', 'right');

    expect(await artistsActedCountFor(env.DB, 'u1')).toBe(3);
  });

  it('counts only the given user\'s own swiped artists', async () => {
    await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp2', createdAt: 1000, updatedAt: 1000 });
    await insertSwipe('u1', 's1', 'artist', 'right');
    await insertSwipe('u2', 's2', 'artist', 'right');

    expect(await artistsActedCountFor(env.DB, 'u1')).toBe(1);
  });
});
