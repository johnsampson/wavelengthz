import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { insertTestUser } from '../helpers/createUser';
import { compareWindows, getTasteDrift, DRIFT_WINDOW_DAYS, MIN_LIKES_FOR_TREND } from '../../src/lib/tasteDrift';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM artist_genres; DELETE FROM music_swipes; DELETE FROM tracks; DELETE FROM artists; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp-u1', createdAt: 1000, updatedAt: 1000 });
});

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

async function artist(id: string, genres: string[]) {
  await env.DB.prepare(
    `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at, updated_at) VALUES (?, ?, ?, '{}', 'spotify', 1, 1000, 1000)`
  ).bind(id, `sp-${id}`, `Artist ${id}`).run();
  for (const g of genres) {
    await env.DB.prepare(
      `INSERT INTO artist_genres (id, artist_id, mb_genre_id, name, count, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1000, 1000)`
    ).bind(crypto.randomUUID(), id, g, g).run();
  }
}

async function swipe(itemType: 'artist' | 'track', itemId: string, daysAgo: number, direction = 'right') {
  await env.DB.prepare(
    `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES (?, 'u1', ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), itemType, itemId, direction, NOW - daysAgo * DAY, NOW).run();
}

describe('compareWindows', () => {
  const m = (o: Record<string, number>) => new Map(Object.entries(o));

  it('ranks the biggest riser first', () => {
    const { rising } = compareWindows(m({ ambient: 8, punk: 4 }), m({ ambient: 1, punk: 3 }));
    expect(rising.map((r) => r.genre)).toEqual(['ambient', 'punk']);
    expect(rising[0].change).toBe(7);
  });

  it('ignores a riser that never clears the noise floor', () => {
    // Two likes is not a trend, and saying it is makes the whole feature
    // feel invented.
    const { rising } = compareWindows(m({ ambient: MIN_LIKES_FOR_TREND - 1 }), m({}));
    expect(rising).toEqual([]);
  });

  it('judges a faller on its previous window, where the claim is being made', () => {
    const { falling } = compareWindows(m({ punk: 0 }), m({ punk: 9 }));
    expect(falling[0]).toMatchObject({ genre: 'punk', change: -9 });
  });

  it('ignores a faller that was never significant to begin with', () => {
    const { falling } = compareWindows(m({}), m({ punk: MIN_LIKES_FOR_TREND - 1 }));
    expect(falling).toEqual([]);
  });

  it('drops genres that did not move at all', () => {
    const { rising, falling } = compareWindows(m({ ambient: 5 }), m({ ambient: 5 }));
    expect(rising).toEqual([]);
    expect(falling).toEqual([]);
  });

  it('breaks ties by name so the same data always renders the same list', () => {
    // An "insight" that reshuffles between two identical loads reads as broken.
    const a = compareWindows(m({ zeta: 5, alpha: 5 }), m({}));
    const b = compareWindows(m({ alpha: 5, zeta: 5 }), m({}));
    expect(a.rising.map((r) => r.genre)).toEqual(b.rising.map((r) => r.genre));
    expect(a.rising[0].genre).toBe('alpha');
  });

  it('caps each list so it reads as an insight rather than a data dump', () => {
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`g${i}`, 10 - i + MIN_LIKES_FOR_TREND]));
    expect(compareWindows(m(many), m({})).rising).toHaveLength(3);
  });
});

describe('getTasteDrift', () => {
  it('reports insufficient data for a user who has barely swiped', async () => {
    await artist('a1', ['ambient']);
    await swipe('artist', 'a1', 2);

    const drift = await getTasteDrift(env.DB, 'u1', NOW);

    expect(drift.insufficientData).toBe(true);
    expect(drift.rising).toEqual([]);
  });

  it('detects a genre the user moved toward', async () => {
    await artist('amb1', ['ambient']);
    await artist('amb2', ['ambient']);
    await artist('amb3', ['ambient']);
    await artist('pk1', ['punk']);
    // Recent window: three ambient likes.
    await swipe('artist', 'amb1', 2);
    await swipe('artist', 'amb2', 5);
    await swipe('artist', 'amb3', 10);
    // Prior window: one punk like.
    await swipe('artist', 'pk1', DRIFT_WINDOW_DAYS + 5);

    const drift = await getTasteDrift(env.DB, 'u1', NOW);

    expect(drift.insufficientData).toBe(false);
    expect(drift.rising[0]).toMatchObject({ genre: 'ambient', current: 3, previous: 0 });
  });

  it('counts track likes toward their artist genre, not just artist likes', async () => {
    // A track like is a genre signal in exactly the way an artist like is;
    // ignoring it would miss most of what an active user does.
    await artist('a1', ['ambient']);
    for (const t of ['t1', 't2', 't3']) {
      await env.DB.prepare(
        `INSERT INTO tracks (id, artist_id, spotify_id, name, source, approved, created_at, updated_at) VALUES (?, 'a1', ?, ?, 'spotify', 1, 1000, 1000)`
      ).bind(t, `sp-${t}`, t).run();
      await swipe('track', t, 3);
    }

    const drift = await getTasteDrift(env.DB, 'u1', NOW);

    expect(drift.rising[0]).toMatchObject({ genre: 'ambient', current: 3 });
  });

  it('ignores passes and skips -- only likes signal taste', async () => {
    await artist('a1', ['ambient']);
    await artist('a2', ['ambient']);
    await artist('a3', ['ambient']);
    await swipe('artist', 'a1', 2, 'left');
    await swipe('artist', 'a2', 3, 'skip');
    await swipe('artist', 'a3', 4, 'left');

    const drift = await getTasteDrift(env.DB, 'u1', NOW);

    expect(drift.likesInWindow).toBe(0);
    expect(drift.insufficientData).toBe(true);
  });

  it('ignores activity older than both windows', async () => {
    await artist('a1', ['ambient']);
    await artist('a2', ['ambient']);
    await artist('a3', ['ambient']);
    await swipe('artist', 'a1', 2);
    await swipe('artist', 'a2', 3);
    await swipe('artist', 'a3', 4);
    // Ancient punk phase, well outside both windows -- must not register as
    // a fall, because there is nothing recent to compare it against.
    await artist('old', ['punk']);
    await swipe('artist', 'old', DRIFT_WINDOW_DAYS * 5);

    const drift = await getTasteDrift(env.DB, 'u1', NOW);

    expect(drift.falling.map((f) => f.genre)).not.toContain('punk');
  });

  it('is scoped to the viewer', async () => {
    await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp-u2', createdAt: 1000, updatedAt: 1000 });
    await artist('a1', ['ambient']);
    await swipe('artist', 'a1', 2);

    expect((await getTasteDrift(env.DB, 'u2', NOW)).likesInWindow).toBe(0);
  });
});
