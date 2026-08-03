import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { encrypt } from '../../src/lib/crypto';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  // music_profiles and sessions both FK-reference users(id), so they must be
  // cleared before users to avoid a foreign key constraint violation.
  await env.DB.exec('DELETE FROM sessions; DELETE FROM music_profiles; DELETE FROM users;');
});

describe('GET /api/me', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/me'), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('returns the user and pulls a music profile on first call', async () => {
    const encToken = await encrypt('access-tok', env.TOKEN_ENCRYPTION_KEY);
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES ('u1', 'sp1', ?, ?, ?, 1000, 1000)`
    ).bind(encToken, encToken, Date.now() + 100000).run();
    const { cookie } = await createSession(env.DB, 'u1');
    const sessionId = cookie.split(';')[0].split('=')[1];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('top/artists')) {
          return new Response(JSON.stringify({ items: [{ id: 'a1', name: 'Artist One', genres: ['pop'] }] }), { status: 200 });
        }
        if (url.includes('top/tracks')) {
          return new Response(JSON.stringify({ items: [{ id: 't1', name: 'Track One' }] }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const req = new Request('http://localhost/api/me', { headers: { Cookie: `wl_session=${sessionId}` } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.user.id).toBe('u1');
    expect(body.musicProfile.top_artists).toContain('a1');

    const row = await env.DB.prepare('SELECT * FROM music_profiles WHERE user_id = ?').bind('u1').first<any>();
    expect(row).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it('does not throw when a concurrent request wins the music_profiles insert race', async () => {
    const encToken = await encrypt('access-tok', env.TOKEN_ENCRYPTION_KEY);
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES ('u2', 'sp2', ?, ?, ?, 1000, 1000)`
    ).bind(encToken, encToken, Date.now() + 100000).run();
    const { cookie } = await createSession(env.DB, 'u2');
    const sessionId = cookie.split(';')[0].split('=')[1];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('top/artists')) {
          return new Response(JSON.stringify({ items: [{ id: 'a2', name: 'Artist Two', genres: ['rock'] }] }), { status: 200 });
        }
        if (url.includes('top/tracks')) {
          return new Response(JSON.stringify({ items: [{ id: 't2', name: 'Track Two' }] }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const realDb = env.DB;
    let racedAlready = false;

    // Simulates a second concurrent /api/me request winning the race: right before
    // our own INSERT executes, another row for the same user_id lands in the table
    // (as if a concurrent request's INSERT completed first). With plain INSERT this
    // would throw a primary-key violation; with INSERT OR IGNORE it should not.
    const racyDb = {
      prepare: (sql: string) => {
        const real = realDb.prepare(sql);
        if (sql.includes('INTO music_profiles') && !racedAlready) {
          racedAlready = true;
          return {
            bind: (...args: unknown[]) => {
              const boundReal = real.bind(...args);
              return {
                run: async () => {
                  await realDb
                    .prepare(
                      `INSERT INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at)
                       VALUES (?, '[]', '[]', '[]', 'medium_term', ?)`
                    )
                    .bind(args[0], Date.now())
                    .run();
                  return boundReal.run();
                },
              };
            },
          };
        }
        return real;
      },
    } as unknown as D1Database;

    const racyEnv = { ...env, DB: racyDb };

    const req = new Request('http://localhost/api/me', { headers: { Cookie: `wl_session=${sessionId}` } });
    const res = await worker.fetch(req, racyEnv, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.user.id).toBe('u2');
    expect(body.musicProfile.top_artists).toContain('a2');

    const rows = await realDb.prepare('SELECT * FROM music_profiles WHERE user_id = ?').bind('u2').all();
    expect(rows.results.length).toBe(1);

    vi.unstubAllGlobals();
  });

  // Regression test for a Task 4 code-review finding that was deferred to Task 18:
  // an uncaught Spotify API failure inside /api/me previously propagated as a raw
  // exception instead of a graceful error response. Task 18 added a global
  // try/catch around routing (src/index.ts) that should now convert this into a
  // clean 500 with no internal error details leaked into the response body.
  it('returns a clean 500 with no leaked error details when the Spotify API call throws', async () => {
    const encToken = await encrypt('access-tok', env.TOKEN_ENCRYPTION_KEY);
    await env.DB.prepare(
      `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
       VALUES ('u3', 'sp3', ?, ?, ?, 1000, 1000)`
    ).bind(encToken, encToken, Date.now() + 100000).run();
    const { cookie } = await createSession(env.DB, 'u3');
    const sessionId = cookie.split(';')[0].split('=')[1];

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Spotify API is down, secret=abc123');
      })
    );

    const req = new Request('http://localhost/api/me', {
      headers: { Cookie: `wl_session=${sessionId}`, 'CF-Connecting-IP': '5.5.5.5' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('Spotify API is down');
    expect(text).not.toContain('secret=abc123');

    vi.unstubAllGlobals();
  });
});
