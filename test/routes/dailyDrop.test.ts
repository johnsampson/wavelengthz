import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import { currentDayIndex, promptSortOrderForDay } from '../../src/lib/dailyDrop';
import worker from '../../src/index';

// Fixed "now" so every test lands on the same, known prompt regardless of
// when the suite actually runs -- currentDayIndex/promptSortOrderForDay are
// pure, so the resulting prompt is fully deterministic from this constant.
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const DAY_INDEX = currentDayIndex(NOW);

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await env.DB.exec(
    'DELETE FROM daily_drop_answers; DELETE FROM blocks; DELETE FROM sessions; DELETE FROM tracks; ' +
      'DELETE FROM artists; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function makeUser(id: string, overrides: Partial<Parameters<typeof insertTestUser>[1]> = {}) {
  await insertTestUser(env.DB, {
    id,
    spotifyId: `sp-${id}`,
    gender: 'female',
    seeking: 'male',
    onboardedAt: 1000,
    accessToken: 'a',
    refreshToken: 'r',
    tokenExpiresAt: 9999999999999,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  });
}

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

/** Only the token + GET /v1/artists/{id} are legal -- same stub as matches.test.ts's identical helper. */
function stubArtistLookup() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      if (url.includes('/v1/artists/')) {
        return new Response(
          JSON.stringify({ id: 'sp-artist-1', name: 'Some Artist', genres: ['indie'], images: [{ url: 'https://i/a.jpg' }], popularity: 60 }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    })
  );
}

const track = (id = 'sp-t1') => ({
  id,
  name: `Song ${id}`,
  artists: [{ id: 'sp-artist-1', name: 'Some Artist' }],
  album: { images: [{ url: `https://i/${id}.jpg` }] },
});

async function getDrop(cookie: string) {
  return worker.fetch(new Request('http://localhost/api/daily-drop', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
}

async function postAnswer(cookie: string, body: any) {
  return worker.fetch(
    new Request('http://localhost/api/daily-drop/answer', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    {} as ExecutionContext
  );
}

async function getAnswers(cookie: string) {
  return worker.fetch(new Request('http://localhost/api/daily-drop/answers', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
}

describe('GET /api/daily-drop', () => {
  it('returns 401 when not logged in', async () => {
    expect((await getDrop('')).status).toBe(401);
  });

  it('returns 400 when onboarding is incomplete (gender/seeking unset)', async () => {
    await makeUser('u1', { gender: null, seeking: null });
    const res = await getDrop(await cookieFor('u1'));
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error).toBe('onboarding_incomplete');
  });

  it("returns today's prompt (matching the pure rotation formula) with no answer yet", async () => {
    await makeUser('u1');
    const res = await getDrop(await cookieFor('u1'));
    expect(res.status).toBe(200);
    const body = await res.json<any>();

    const expectedSortOrder = promptSortOrderForDay(DAY_INDEX);
    const expectedRow = await env.DB.prepare('SELECT text FROM daily_prompts WHERE sort_order = ?').bind(expectedSortOrder).first<any>();
    expect(body.prompt.text).toBe(expectedRow.text);
    expect(body.myAnswer).toBeNull();
    expect(body.answerCount).toBe(0);
  });

  it('reflects a submitted answer and a non-zero answer count', async () => {
    stubArtistLookup();
    await makeUser('u1');
    const cookie = await cookieFor('u1');
    await postAnswer(cookie, { track: track() });

    const res = await getDrop(cookie);
    const body = await res.json<any>();
    expect(body.myAnswer).toMatchObject({ name: 'Song sp-t1', artistName: 'Some Artist' });
    expect(body.answerCount).toBe(1);
  });
});

describe('POST /api/daily-drop/answer', () => {
  it('returns 401 when not logged in', async () => {
    expect((await postAnswer('', { track: track() })).status).toBe(401);
  });

  it('returns 400 when no track is provided', async () => {
    await makeUser('u1');
    const res = await postAnswer(await cookieFor('u1'), {});
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error).toBe('invalid_track');
  });

  it('resolves a brand-new track (one Spotify artist call) and stores it', async () => {
    stubArtistLookup();
    await makeUser('u1');
    const res = await postAnswer(await cookieFor('u1'), { track: track() });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT day_index, prompt_id, track_id FROM daily_drop_answers WHERE user_id = ?')
      .bind('u1')
      .first<any>();
    expect(row.day_index).toBe(DAY_INDEX);
    const expectedPrompt = await env.DB.prepare('SELECT id FROM daily_prompts WHERE sort_order = ?')
      .bind(promptSortOrderForDay(DAY_INDEX))
      .first<any>();
    expect(row.prompt_id).toBe(expectedPrompt.id);
  });

  it('costs zero Spotify calls for an already-cataloged track (DB-first)', async () => {
    await makeUser('u1');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, image_url, popularity, source, added_by_user_id, approved, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'user_added', NULL, 1, ?, ?)`
    )
      .bind('artist-1', 'sp-artist-1', 'Some Artist', '{}', null, null, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO tracks (id, spotify_id, name, artist_id, album_image_url, preview_url, duration_ms, source, added_by_user_id, approved, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'user_added', NULL, 1, ?, ?)`
    )
      .bind('track-1', 'sp-t1', 'Song sp-t1', 'artist-1', null, now, now)
      .run();

    const fetchMock = vi.fn(async () => {
      throw new Error('should never call Spotify for an already-cataloged track');
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await postAnswer(await cookieFor('u1'), { track: track() });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();

    const row = await env.DB.prepare('SELECT track_id FROM daily_drop_answers WHERE user_id = ?').bind('u1').first<any>();
    expect(row.track_id).toBe('track-1');
  });

  it('overwrites, not duplicates, when resubmitting the same day', async () => {
    stubArtistLookup();
    await makeUser('u1');
    const cookie = await cookieFor('u1');

    await postAnswer(cookie, { track: track('sp-t1') });
    await postAnswer(cookie, { track: track('sp-t2') });

    const rows = await env.DB.prepare('SELECT COUNT(*) c FROM daily_drop_answers WHERE user_id = ?').bind('u1').first<any>();
    expect(rows.c).toBe(1);

    const res = await getDrop(cookie);
    expect((await res.json<any>()).myAnswer.name).toBe('Song sp-t2');
  });

  it('reports 503 (not 400) when Spotify cannot resolve the artist, and stores nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await makeUser('u1');

    const res = await postAnswer(await cookieFor('u1'), { track: track() });
    expect(res.status).toBe(503);
    expect((await res.json<any>()).error).toBe('artist_unavailable');
    const count = await env.DB.prepare('SELECT COUNT(*) c FROM daily_drop_answers').first<any>();
    expect(count.c).toBe(0);
  });
});

describe('GET /api/daily-drop/answers', () => {
  it('excludes my own answer', async () => {
    stubArtistLookup();
    await makeUser('u1');
    await postAnswer(await cookieFor('u1'), { track: track() });

    const res = await getAnswers(await cookieFor('u1'));
    expect((await res.json<any>()).answers).toEqual([]);
  });

  it('includes an eligible (reciprocal, unblocked) answer from someone else', async () => {
    stubArtistLookup();
    await makeUser('u1', { gender: 'female', seeking: 'male' });
    await makeUser('u2', { gender: 'male', seeking: 'female', displayName: 'Sam' });
    await postAnswer(await cookieFor('u2'), { track: track() });

    const res = await getAnswers(await cookieFor('u1'));
    const body = await res.json<any>();
    expect(body.answers).toHaveLength(1);
    expect(body.answers[0]).toMatchObject({ userId: 'u2', displayName: 'Sam' });
    expect(body.answers[0].track).toMatchObject({ name: 'Song sp-t1' });
  });

  it('excludes a non-reciprocal (seeking mismatch) answer', async () => {
    stubArtistLookup();
    await makeUser('u1', { gender: 'female', seeking: 'male' });
    // u2 is a woman seeking women -- never reciprocal with u1's "seeking men".
    await makeUser('u2', { gender: 'female', seeking: 'female' });
    await postAnswer(await cookieFor('u2'), { track: track() });

    const res = await getAnswers(await cookieFor('u1'));
    expect((await res.json<any>()).answers).toEqual([]);
  });

  it('excludes an answer from someone blocked in either direction', async () => {
    stubArtistLookup();
    await makeUser('u1', { gender: 'female', seeking: 'male' });
    await makeUser('u2', { gender: 'male', seeking: 'female' });
    await postAnswer(await cookieFor('u2'), { track: track() });
    await env.DB.prepare('INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES (?, ?, ?, ?)')
      .bind('b1', 'u1', 'u2', Date.now())
      .run();

    const res = await getAnswers(await cookieFor('u1'));
    expect((await res.json<any>()).answers).toEqual([]);
  });

  it("excludes someone who hasn't answered today", async () => {
    await makeUser('u1', { gender: 'female', seeking: 'male' });
    await makeUser('u2', { gender: 'male', seeking: 'female' });

    const res = await getAnswers(await cookieFor('u1'));
    expect((await res.json<any>()).answers).toEqual([]);
  });
});
