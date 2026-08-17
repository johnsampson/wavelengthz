import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { insertTestUser } from '../helpers/createUser';
import { likedFirst, likedTrackIdsForArtist } from '../../src/lib/trackOrdering';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM music_swipes; DELETE FROM tracks; DELETE FROM artists; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
});

const t = (internalId: string) => ({ internalId });

describe('likedFirst', () => {
  it('moves liked tracks to the front', () => {
    const out = likedFirst([t('a'), t('b'), t('c')], new Set(['c']));
    expect(out.map((x) => x.internalId)).toEqual(['c', 'a', 'b']);
  });

  it('preserves release order within the liked block and within the rest', () => {
    // The incoming order is rowid -- roughly release order, the same ordering
    // the artist page and radio already use. Grouping must not scramble it.
    const out = likedFirst([t('a'), t('b'), t('c'), t('d'), t('e')], new Set(['d', 'b']));
    expect(out.map((x) => x.internalId)).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('returns the list untouched when nothing is liked', () => {
    const input = [t('a'), t('b')];
    expect(likedFirst(input, new Set())).toBe(input);
  });

  it('ignores liked ids that are not in the list', () => {
    const out = likedFirst([t('a'), t('b')], new Set(['zzz']));
    expect(out.map((x) => x.internalId)).toEqual(['a', 'b']);
  });

  it('handles an empty list', () => {
    expect(likedFirst([], new Set(['a']))).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [t('a'), t('b'), t('c')];
    likedFirst(input, new Set(['c']));
    expect(input.map((x) => x.internalId)).toEqual(['a', 'b', 'c']);
  });
});

describe('likedTrackIdsForArtist', () => {
  async function seed() {
    await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp-u1', createdAt: 1000, updatedAt: 1000 });
    await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp-u2', createdAt: 1000, updatedAt: 1000 });
    for (const a of ['a1', 'a2']) {
      await env.DB.prepare(
        `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at, updated_at) VALUES (?, ?, ?, '{}', 'spotify', 1, 1000, 1000)`
      )
        .bind(a, `sp-${a}`, `Artist ${a}`)
        .run();
    }
    const tracks: Array<[string, string]> = [['t1', 'a1'], ['t2', 'a1'], ['t3', 'a1'], ['t4', 'a2']];
    for (const [id, artist] of tracks) {
      await env.DB.prepare(
        `INSERT INTO tracks (id, artist_id, spotify_id, name, source, approved, created_at, updated_at) VALUES (?, ?, ?, ?, 'spotify', 1, 1000, 1000)`
      )
        .bind(id, artist, `sp-${id}`, `Track ${id}`)
        .run();
    }
  }

  async function swipe(userId: string, trackId: string, direction: string) {
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES (?, ?, 'track', ?, ?, 1000, 1000)`
    )
      .bind(crypto.randomUUID(), userId, trackId, direction)
      .run();
  }

  it('returns only right-swiped tracks belonging to that artist', async () => {
    await seed();
    await swipe('u1', 't1', 'right');
    await swipe('u1', 't2', 'left');
    await swipe('u1', 't3', 'skip');
    await swipe('u1', 't4', 'right'); // different artist

    expect([...(await likedTrackIdsForArtist(env.DB, 'u1', 'a1'))]).toEqual(['t1']);
  });

  it('is scoped to the viewer', async () => {
    await seed();
    await swipe('u2', 't1', 'right');

    expect((await likedTrackIdsForArtist(env.DB, 'u1', 'a1')).size).toBe(0);
    expect([...(await likedTrackIdsForArtist(env.DB, 'u2', 'a1'))]).toEqual(['t1']);
  });

  it('returns an empty set for an artist with no liked tracks', async () => {
    await seed();
    expect((await likedTrackIdsForArtist(env.DB, 'u1', 'a1')).size).toBe(0);
  });

  it('ignores a swipe whose track row is gone', async () => {
    // music_swipes.item_id has no FK (see migrations), so a swipe can outlive
    // its track. The JOIN is what keeps such a row from producing an id the
    // caller would then fail to look up.
    await seed();
    await swipe('u1', 'deleted-track', 'right');

    expect((await likedTrackIdsForArtist(env.DB, 'u1', 'a1')).size).toBe(0);
  });
});
