# Artist Catalog Growth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the music/artist swipe deck from ever permanently running out of candidates by replacing the non-advancing, per-request Spotify top-up with a cron-driven catalog growth job that properly paginates each genre's search results, tracked in D1 and alerted on by email.

**Architecture:** A new shared module `src/lib/catalogGrowth.ts` owns a persisted per-genre Spotify search cursor and does the actual "search one page, insert new artists, advance the cursor" work. A new Cron Trigger calls it on a schedule as the primary growth mechanism (replacing the old per-user top-up entirely); the existing `remaining === 0` reactive path in `musicSwipes.ts` keeps calling the same shared logic, but only as a rare last-resort safety net. Every scheduled run is logged to a new D1 table, which a second scheduled job digests into a daily summary email; job failures email immediately in addition to the existing Sentry reporting.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, `wrangler`, Vitest + `@cloudflare/vitest-pool-workers`, Resend (existing `src/lib/email.ts`), Sentry (existing `src/lib/sentry.ts`).

## Global Constraints

- No artist is ever shown to the same user twice, in either swipe direction — this plan does not touch the existing `music_swipes` exclusion in `GET /api/candidates/music`'s query, and introduces no recycling of past swipes. Supply must come purely from genuinely new artists (spec: `docs/superpowers/specs/2026-08-08-artist-catalog-growth-design.md`).
- Recommendation/scoring algorithm quality (`src/lib/scoring.ts`, `src/lib/matching.ts`) and the people-matching deck (`src/routes/peopleSwipes.ts`) are explicitly out of scope.
- Spotify's real, already-relied-upon limits (see `src/db/seed.ts`): `/v1/search` max page size is 10, and `offset + limit` cannot exceed 1000 — this plan uses the same `SEARCH_PAGE_SIZE = 10` / `SPOTIFY_MAX_OFFSET = 950` constants independently in `catalogGrowth.ts`.
- Per-artist genre tags from Spotify are unreliable/effectively always empty (already documented in this codebase at `src/lib/spotify.ts:88-90` and confirmed against the live API per `docs/superpowers/plans/2026-08-02-wavelengthz-build.md`'s Post-Launch Changes) — genre selection for growth is never personalized; it round-robins a fixed genre list.
- `ARTIST_CATALOG_GROWTH_ENABLED` (plain `wrangler.toml` var): `"false"` makes the scheduled growth job a no-op; unset or any other value means enabled. Flippable via `wrangler secret put` or the dashboard without a code deploy.
- `OPS_ALERT_EMAIL` (secret, never committed): the recipient for both the failure alert and the daily digest. Unset means both are silent no-ops — never throw.
- No new email/error-tracking providers — reuse `sendEmail` (`src/lib/email.ts`, Resend) and `reportError` (`src/lib/sentry.ts`, Sentry) exactly as everywhere else in the codebase.
- New cron schedules added to `wrangler.toml`'s `crons` array: `*/15 * * * *` (growth job), `0 13 * * *` (daily digest) — alongside the 3 already there.

---

### Task 1: Genre search cursor + `growOneGenre` (single-genre page search & insert)

**Files:**
- Create: `migrations/0005_artist_catalog_growth.sql`
- Create: `src/lib/catalogGrowth.ts`
- Create: `test/lib/catalogGrowth.test.ts`

**Interfaces:**
- Consumes: `getClientCredentialsToken`, `searchArtistsByGenre`, `searchTracksByArtistName` (`src/lib/spotify.ts`); `upsertArtist`, `upsertTrack` (`src/lib/catalogUpsert.ts`); `recordCatalogGenres` (`src/lib/genreCatalog.ts`).
- Produces: `GROWTH_GENRES: string[]` and `growOneGenre(db: D1Database, token: string, genre: string, now: number): Promise<{ inserted: number }>` from `src/lib/catalogGrowth.ts`. Later tasks add `growArtistCatalog`, `runCatalogGrowthJob`, `sendCatalogGrowthDigest` to this same file.
- Produces: new tables `genre_search_cursors(genre TEXT PRIMARY KEY, search_offset INTEGER, exhausted INTEGER, updated_at INTEGER)` and `catalog_growth_runs(id TEXT PRIMARY KEY, started_at INTEGER, finished_at INTEGER, genres_tried TEXT, inserted_count INTEGER, error TEXT, created_at INTEGER)` — the second isn't consumed until Task 3, but both are part of the same feature's schema.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0005_artist_catalog_growth.sql
-- Migration number: 0005 	 2026-08-08T12:00:00.000Z

-- Persisted per-genre Spotify search pagination cursor for artist catalog
-- growth (src/lib/catalogGrowth.ts) -- replaces the old artistTopUp's
-- single-random-offset search, which never advanced and re-sampled the
-- same shallow window of each genre's results forever. `exhausted` is set
-- once a page comes back shorter than a full page (or the offset has
-- walked past Spotify's real max), so growth knows to move on instead of
-- re-querying a genre with nothing left to find.
CREATE TABLE genre_search_cursors (
  genre         TEXT PRIMARY KEY,
  search_offset INTEGER NOT NULL DEFAULT 0,
  exhausted     INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

-- One row per scheduled catalog-growth run (src/lib/catalogGrowth.ts) --
-- source of truth for the daily digest email and manual inspection
-- (wrangler d1 execute), independent of Cloudflare's own log retention.
CREATE TABLE catalog_growth_runs (
  id             TEXT PRIMARY KEY,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  genres_tried   TEXT NOT NULL DEFAULT '[]',
  inserted_count INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     INTEGER NOT NULL
);
```

- [ ] **Step 2: Write the failing test for `growOneGenre`**

```typescript
// test/lib/catalogGrowth.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { growOneGenre } from '../../src/lib/catalogGrowth';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM genres; DELETE FROM tracks; DELETE FROM artists; DELETE FROM genre_search_cursors; DELETE FROM catalog_growth_runs;'
  );
});

function stubArtistSearch(items: any[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('type=artist')) return new Response(JSON.stringify({ artists: { items } }), { status: 200 });
      if (url.includes('type=track')) return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
      throw new Error(`unexpected ${url}`);
    })
  );
}

describe('growOneGenre', () => {
  it('inserts new artists and advances the cursor by a full page', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`, name: `Artist ${i}`, genres: ['pop'], images: [{ url: `https://img/${i}.jpg` }], popularity: 50,
    }));
    stubArtistSearch(items);

    const result = await growOneGenre(env.DB, 'token', 'pop', 1000);

    expect(result.inserted).toBe(10);
    const cursor = await env.DB.prepare('SELECT search_offset, exhausted FROM genre_search_cursors WHERE genre = ?').bind('pop').first<any>();
    expect(cursor.search_offset).toBe(10);
    expect(cursor.exhausted).toBe(0);
    vi.unstubAllGlobals();
  });

  it('marks the genre exhausted when a page comes back shorter than a full page', async () => {
    stubArtistSearch([{ id: 'a1', name: 'Solo Artist', genres: ['jazz'], images: [{ url: 'https://img/a1.jpg' }], popularity: 50 }]);

    await growOneGenre(env.DB, 'token', 'jazz', 1000);

    const cursor = await env.DB.prepare('SELECT exhausted FROM genre_search_cursors WHERE genre = ?').bind('jazz').first<any>();
    expect(cursor.exhausted).toBe(1);
    vi.unstubAllGlobals();
  });

  it('skips an artist with no photo but still advances the cursor', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, name: `Artist ${i}`, genres: [], images: [], popularity: 50 }));
    stubArtistSearch(items);

    const result = await growOneGenre(env.DB, 'token', 'rock', 1000);

    expect(result.inserted).toBe(0);
    const cursor = await env.DB.prepare('SELECT search_offset FROM genre_search_cursors WHERE genre = ?').bind('rock').first<any>();
    expect(cursor.search_offset).toBe(10);
    vi.unstubAllGlobals();
  });

  it('skips an artist already in the catalog', async () => {
    await env.DB.prepare(
      `INSERT INTO artists (id, spotify_id, name, genres, image_url, source, approved, created_at) VALUES ('x', 'a1', 'Existing', '{}', '/x.jpg', 'seed', 1, 1000)`
    ).run();
    stubArtistSearch([{ id: 'a1', name: 'Existing', genres: [], images: [{ url: '/x.jpg' }], popularity: 50 }]);

    const result = await growOneGenre(env.DB, 'token', 'indie', 1000);

    expect(result.inserted).toBe(0);
    vi.unstubAllGlobals();
  });

  it('does not call Spotify once the offset has walked past the max, and marks exhausted', async () => {
    await env.DB.prepare(
      `INSERT INTO genre_search_cursors (genre, search_offset, exhausted, updated_at) VALUES ('metal', 960, 0, 1000)`
    ).run();
    const fetchMock = vi.fn(async () => {
      throw new Error('should not be called');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await growOneGenre(env.DB, 'token', 'metal', 2000);

    expect(result.inserted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const cursor = await env.DB.prepare('SELECT exhausted FROM genre_search_cursors WHERE genre = ?').bind('metal').first<any>();
    expect(cursor.exhausted).toBe(1);
    vi.unstubAllGlobals();
  });

  it('leaves the cursor untouched and rethrows when the Spotify search fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));

    await expect(growOneGenre(env.DB, 'token', 'folk', 1000)).rejects.toThrow();

    const cursor = await env.DB.prepare('SELECT * FROM genre_search_cursors WHERE genre = ?').bind('folk').first();
    expect(cursor).toBeNull(); // never created -- no progress recorded on failure
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/lib/catalogGrowth.test.ts`
Expected: FAIL — `src/lib/catalogGrowth.ts` does not exist.

- [ ] **Step 4: Write `src/lib/catalogGrowth.ts`**

```typescript
import { searchArtistsByGenre, searchTracksByArtistName } from './spotify';
import { recordCatalogGenres } from './genreCatalog';
import { upsertArtist, upsertTrack } from './catalogUpsert';

// Wider than src/db/seed.ts's SEED_GENRES (used only for the one-time
// initial catalog build). Growth runs forever and must never let a user
// see a repeat, so more genres means more total addressable artists before
// the shared catalog's ceiling is reached.
export const GROWTH_GENRES = [
  'pop', 'hip-hop', 'indie', 'r-n-b', 'country', 'electronic',
  'latin', 'rock', 'k-pop', 'jazz', 'classical', 'reggaeton',
  'metal', 'folk', 'soul', 'funk', 'blues', 'punk', 'alternative', 'dance',
];

// Same real Spotify limits src/db/seed.ts's seedCatalog already relies on:
// /v1/search's documented per-page max is 10, and offset+limit can't exceed
// Spotify's own 1000 cap.
const SEARCH_PAGE_SIZE = 10;
const SPOTIFY_MAX_OFFSET = 950;
const TRACKS_PER_ARTIST = 2;

interface GenreCursor {
  genre: string;
  searchOffset: number;
  exhausted: boolean;
}

async function loadCursor(db: D1Database, genre: string): Promise<GenreCursor> {
  const row = await db
    .prepare('SELECT search_offset, exhausted FROM genre_search_cursors WHERE genre = ?')
    .bind(genre)
    .first<{ search_offset: number; exhausted: number }>();
  if (!row) return { genre, searchOffset: 0, exhausted: false };
  return { genre, searchOffset: row.search_offset, exhausted: row.exhausted === 1 };
}

async function saveCursor(db: D1Database, cursor: GenreCursor, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO genre_search_cursors (genre, search_offset, exhausted, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(genre) DO UPDATE SET search_offset = excluded.search_offset, exhausted = excluded.exhausted, updated_at = excluded.updated_at`
    )
    .bind(cursor.genre, cursor.searchOffset, cursor.exhausted ? 1 : 0, now)
    .run();
}

/**
 * Searches ONE page of one genre at its persisted offset, inserts any
 * genuinely new artist (+ up to TRACKS_PER_ARTIST tracks each), and
 * advances the genre's cursor. A genre is marked exhausted once a page
 * comes back short of SEARCH_PAGE_SIZE or the offset has walked past
 * Spotify's real max -- never on a search error, so a transient failure
 * retries the same offset next time instead of skipping ahead.
 */
export async function growOneGenre(db: D1Database, token: string, genre: string, now: number): Promise<{ inserted: number }> {
  const cursor = await loadCursor(db, genre);
  if (cursor.searchOffset > SPOTIFY_MAX_OFFSET) {
    if (!cursor.exhausted) await saveCursor(db, { ...cursor, exhausted: true }, now);
    return { inserted: 0 };
  }

  const artists = await searchArtistsByGenre(token, genre, SEARCH_PAGE_SIZE, cursor.searchOffset);

  let inserted = 0;
  for (const artist of artists) {
    // Candidates require a real photo (src/routes/musicSwipes.ts) -- skip
    // here so nothing gets inserted that could never actually surface.
    if (!artist.images?.[0]?.url) continue;

    const existing = await db.prepare('SELECT 1 FROM artists WHERE spotify_id = ?').bind(artist.id).first();
    if (existing) continue;

    const artistResult = await upsertArtist(db, artist, 'spotify_search', null, now);
    if (!artistResult.inserted) continue;
    inserted += 1;
    await recordCatalogGenres(db, artist.genres ?? [], 'artist', now);

    const tracks = await searchTracksByArtistName(token, artist.name, TRACKS_PER_ARTIST);
    for (const track of tracks) {
      const trackResult = await upsertTrack(db, track, artistResult.id, 'spotify_search', null, now);
      if (trackResult.inserted) await recordCatalogGenres(db, artist.genres ?? [], 'track', now);
    }
  }

  await saveCursor(
    db,
    { genre, searchOffset: cursor.searchOffset + SEARCH_PAGE_SIZE, exhausted: artists.length < SEARCH_PAGE_SIZE },
    now
  );

  return { inserted };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/lib/catalogGrowth.test.ts`
Expected: PASS (6/6)

- [ ] **Step 6: Commit**

```bash
git add migrations/0005_artist_catalog_growth.sql src/lib/catalogGrowth.ts test/lib/catalogGrowth.test.ts
git commit -m "feat: add persisted per-genre search cursor and single-page growth primitive"
```

---

### Task 2: `growArtistCatalog` orchestrator

**Files:**
- Modify: `src/lib/catalogGrowth.ts`
- Modify: `test/lib/catalogGrowth.test.ts`

**Interfaces:**
- Consumes: `growOneGenre`, `GROWTH_GENRES` (Task 1); `getClientCredentialsToken` (`src/lib/spotify.ts`).
- Produces: `export interface GrowthResult { inserted: number; genresTried: string[]; errors: Record<string, string> }` and `growArtistCatalog(env: Env, now: number, options: { maxInserted: number; maxGenres?: number }): Promise<GrowthResult>` from `src/lib/catalogGrowth.ts`.

- [ ] **Step 1: Write the failing tests for `growArtistCatalog`**

Append to `test/lib/catalogGrowth.test.ts`:

```typescript
import { growArtistCatalog, GROWTH_GENRES } from '../../src/lib/catalogGrowth';

function stubArtistSearchByGenre(perGenre: (genre: string) => any[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      if (url.includes('type=artist')) {
        const genre = decodeURIComponent(url).match(/genre:"([^"]+)"/)?.[1] ?? '';
        return new Response(JSON.stringify({ artists: { items: perGenre(genre) } }), { status: 200 });
      }
      if (url.includes('type=track')) return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
      throw new Error(`unexpected ${url}`);
    })
  );
}

describe('growArtistCatalog', () => {
  it('tries genres in order and stops once maxInserted is reached', async () => {
    const genresCalled: string[] = [];
    stubArtistSearchByGenre((genre) => {
      genresCalled.push(genre);
      return [{ id: `${genre}-1`, name: genre, genres: [genre], images: [{ url: `https://img/${genre}.jpg` }], popularity: 50 }];
    });

    const result = await growArtistCatalog(env as any, 1000, { maxInserted: 2 });

    expect(result.inserted).toBe(2);
    expect(genresCalled).toEqual([GROWTH_GENRES[0], GROWTH_GENRES[1]]);
    vi.unstubAllGlobals();
  });

  it('stops after maxGenres real Spotify attempts when given', async () => {
    const genresCalled: string[] = [];
    // Every genre returns nothing new, so maxInserted is never reached --
    // only maxGenres bounds how many are tried.
    stubArtistSearchByGenre((genre) => {
      genresCalled.push(genre);
      return [];
    });

    const result = await growArtistCatalog(env as any, 1000, { maxInserted: 100, maxGenres: 3 });

    expect(result.inserted).toBe(0);
    expect(genresCalled.length).toBe(3);
    expect(result.genresTried.length).toBe(3);
    vi.unstubAllGlobals();
  });

  it('skips a genre already marked exhausted without calling Spotify for it', async () => {
    await env.DB.prepare(
      `INSERT INTO genre_search_cursors (genre, search_offset, exhausted, updated_at) VALUES (?, 500, 1, 1000)`
    ).bind(GROWTH_GENRES[0]).run();
    const genresCalled: string[] = [];
    stubArtistSearchByGenre((genre) => {
      genresCalled.push(genre);
      return [{ id: `${genre}-1`, name: genre, genres: [], images: [{ url: 'https://img/x.jpg' }], popularity: 50 }];
    });

    const result = await growArtistCatalog(env as any, 1000, { maxInserted: 1 });

    expect(genresCalled).not.toContain(GROWTH_GENRES[0]);
    expect(result.inserted).toBe(1);
    vi.unstubAllGlobals();
  });

  it('resets every genre cursor once all of them are exhausted', async () => {
    for (const genre of GROWTH_GENRES) {
      await env.DB.prepare(
        `INSERT INTO genre_search_cursors (genre, search_offset, exhausted, updated_at) VALUES (?, 500, 1, 1000)`
      ).bind(genre).run();
    }
    stubArtistSearchByGenre((genre) => [{ id: `${genre}-1`, name: genre, genres: [], images: [{ url: 'https://img/x.jpg' }], popularity: 50 }]);

    const result = await growArtistCatalog(env as any, 2000, { maxInserted: 1 });

    expect(result.inserted).toBe(1); // proves at least one genre was actually tried, not all skipped
    const cursor = await env.DB.prepare('SELECT search_offset, exhausted FROM genre_search_cursors WHERE genre = ?')
      .bind(GROWTH_GENRES[1]) // untried by this call (maxInserted:1 stopped after the first) but still reset
      .first<any>();
    expect(cursor.search_offset).toBe(0);
    expect(cursor.exhausted).toBe(0);
    vi.unstubAllGlobals();
  });

  it('records a per-genre error without aborting the rest of the run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('type=artist')) {
          const genre = decodeURIComponent(url).match(/genre:"([^"]+)"/)?.[1] ?? '';
          if (genre === GROWTH_GENRES[0]) return new Response('server error', { status: 500 });
          return new Response(JSON.stringify({ artists: { items: [{ id: `${genre}-1`, name: genre, genres: [], images: [{ url: 'https://img/x.jpg' }], popularity: 50 }] } }), { status: 200 });
        }
        if (url.includes('type=track')) return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
        throw new Error(`unexpected ${url}`);
      })
    );

    const result = await growArtistCatalog(env as any, 1000, { maxInserted: 1 });

    expect(result.errors[GROWTH_GENRES[0]]).toBeTruthy();
    expect(result.inserted).toBe(1); // second genre still succeeded
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/catalogGrowth.test.ts`
Expected: FAIL — `growArtistCatalog` is not exported.

- [ ] **Step 3: Add `growArtistCatalog` to `src/lib/catalogGrowth.ts`**

Add this import at the top (alongside the existing ones):

```typescript
import { getClientCredentialsToken } from './spotify';
```

Append to the file:

```typescript
export interface GrowthResult {
  inserted: number;
  genresTried: string[];
  errors: Record<string, string>;
}

/**
 * Round-robins GROWTH_GENRES (in list order) via growOneGenre, stopping
 * once maxInserted new artists have been inserted, maxGenres real Spotify
 * attempts have been made (if given -- the reactive fallback in
 * musicSwipes.ts bounds this to keep a live request's latency reasonable;
 * the cron job leaves it unbounded), or every genre has been considered
 * once. A genre already known exhausted is skipped without costing a
 * Spotify call or counting against maxGenres. If every genre was already
 * exhausted before this call started, all cursors are reset to offset 0
 * first so growth never stalls permanently.
 */
export async function growArtistCatalog(
  env: Env,
  now: number,
  options: { maxInserted: number; maxGenres?: number }
): Promise<GrowthResult> {
  const cursorRows = await env.DB.prepare('SELECT genre, exhausted FROM genre_search_cursors').all<{ genre: string; exhausted: number }>();
  let exhaustedByGenre = new Map(cursorRows.results.map((r) => [r.genre, r.exhausted === 1]));
  const allExhausted = GROWTH_GENRES.every((genre) => exhaustedByGenre.get(genre) === true);

  if (allExhausted) {
    for (const genre of GROWTH_GENRES) {
      await env.DB.prepare(
        `INSERT INTO genre_search_cursors (genre, search_offset, exhausted, updated_at) VALUES (?, 0, 0, ?)
         ON CONFLICT(genre) DO UPDATE SET search_offset = 0, exhausted = 0, updated_at = excluded.updated_at`
      ).bind(genre, now).run();
    }
    exhaustedByGenre = new Map(GROWTH_GENRES.map((genre) => [genre, false]));
  }

  const token = await getClientCredentialsToken(env);
  let inserted = 0;
  const genresTried: string[] = [];
  const errors: Record<string, string> = {};

  for (const genre of GROWTH_GENRES) {
    if (inserted >= options.maxInserted) break;
    if (options.maxGenres !== undefined && genresTried.length >= options.maxGenres) break;
    if (exhaustedByGenre.get(genre)) continue;

    genresTried.push(genre);
    try {
      const { inserted: genreInserted } = await growOneGenre(env.DB, token, genre, now);
      inserted += genreInserted;
    } catch (error) {
      errors[genre] = error instanceof Error ? error.message : String(error);
    }
  }

  return { inserted, genresTried, errors };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/catalogGrowth.test.ts`
Expected: PASS (11/11)

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalogGrowth.ts test/lib/catalogGrowth.test.ts
git commit -m "feat: add growArtistCatalog orchestrator with exhaustion cycling"
```

---

### Task 3: Scheduled growth job, cron wiring, and failure alerting

**Files:**
- Modify: `src/lib/catalogGrowth.ts`
- Modify: `test/lib/catalogGrowth.test.ts`
- Modify: `src/env.d.ts`
- Modify: `wrangler.toml`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `growArtistCatalog` (Task 2); `sendEmail` (`src/lib/email.ts`); `reportError`/the `report()` closure pattern already in `src/index.ts`'s `scheduled()`.
- Produces: `runCatalogGrowthJob(env: Env, now: number): Promise<void>` from `src/lib/catalogGrowth.ts`. New env fields: `env.ARTIST_CATALOG_GROWTH_ENABLED` (plain var) and `env.OPS_ALERT_EMAIL` (secret, optional) — later tasks (digest, `musicSwipes.ts` refactor) reuse both.

- [ ] **Step 1: Add `OPS_ALERT_EMAIL` to the `Env` type**

In `src/env.d.ts`, add to both the top-level `Env` interface and the `Cloudflare.Env` interface (same treatment as `RESEND_API_KEY` etc. — set via `wrangler secret put`, never committed):

```typescript
  // Recipient for ops alerts from scheduled jobs (src/lib/catalogGrowth.ts)
  // -- failure emails and the daily growth digest. Optional: unset means
  // both are silent no-ops, never a crash.
  OPS_ALERT_EMAIL?: string;
```

- [ ] **Step 2: Write the failing tests for `runCatalogGrowthJob`**

Append to `test/lib/catalogGrowth.test.ts`:

```typescript
import { runCatalogGrowthJob } from '../../src/lib/catalogGrowth';

describe('runCatalogGrowthJob', () => {
  it('does nothing when ARTIST_CATALOG_GROWTH_ENABLED is "false"', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('should not be called');
    });
    vi.stubGlobal('fetch', fetchMock);

    await runCatalogGrowthJob({ ...env, ARTIST_CATALOG_GROWTH_ENABLED: 'false' } as any, 1000);

    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await env.DB.prepare('SELECT * FROM catalog_growth_runs').all();
    expect(rows.results.length).toBe(0);
    vi.unstubAllGlobals();
  });

  it('runs growth and records a successful run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('type=artist')) {
          return new Response(
            JSON.stringify({ artists: { items: [{ id: 'a1', name: 'Fresh', genres: ['pop'], images: [{ url: 'https://img/a1.jpg' }], popularity: 50 }] } }),
            { status: 200 }
          );
        }
        if (url.includes('type=track')) return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
        throw new Error(`unexpected ${url}`);
      })
    );

    await runCatalogGrowthJob(env as any, 1000);

    const row = await env.DB.prepare('SELECT * FROM catalog_growth_runs').first<any>();
    expect(row.inserted_count).toBe(1);
    expect(row.error).toBeNull();
    expect(JSON.parse(row.genres_tried).length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('records a failed run, emails OPS_ALERT_EMAIL, and rethrows when the job fails outright', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response('invalid client', { status: 401 });
      if (url.includes('api.resend.com')) return new Response('{}', { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runCatalogGrowthJob(env as any, 1000)).rejects.toThrow();

    const row = await env.DB.prepare('SELECT * FROM catalog_growth_runs').first<any>();
    expect(row.inserted_count).toBe(0);
    expect(row.error).toContain('401');
    expect(fetchMock.mock.calls.some((c) => c[0].toString().includes('api.resend.com'))).toBe(true);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/lib/catalogGrowth.test.ts`
Expected: FAIL — `runCatalogGrowthJob` is not exported, and `env.test.vars` doesn't have `OPS_ALERT_EMAIL`/`ARTIST_CATALOG_GROWTH_ENABLED` yet.

- [ ] **Step 4: Add `runCatalogGrowthJob` to `src/lib/catalogGrowth.ts`**

Add this import at the top:

```typescript
import { sendEmail } from './email';
```

Append to the file:

```typescript
/**
 * The scheduled entry point (wired in src/index.ts's scheduled()). Writes
 * one row to catalog_growth_runs per invocation regardless of outcome --
 * that table is the source of truth the daily digest reads from. On a
 * whole-job failure (as opposed to a per-genre error, which growArtistCatalog
 * already isolates), sends an immediate email in addition to rethrowing so
 * the outer scheduled() handler's existing Sentry reporting still fires.
 */
export async function runCatalogGrowthJob(env: Env, now: number): Promise<void> {
  if (env.ARTIST_CATALOG_GROWTH_ENABLED === 'false') return;

  const id = crypto.randomUUID();
  try {
    const result = await growArtistCatalog(env, now, { maxInserted: 50 });
    const errorSummary = Object.keys(result.errors).length > 0 ? JSON.stringify(result.errors) : null;
    await env.DB.prepare(
      `INSERT INTO catalog_growth_runs (id, started_at, finished_at, genres_tried, inserted_count, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, now, Date.now(), JSON.stringify(result.genresTried), result.inserted, errorSummary, now).run();
    console.log('catalog growth run', { inserted: result.inserted, genresTried: result.genresTried, errors: result.errors });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('runCatalogGrowthJob failed', error);
    await env.DB.prepare(
      `INSERT INTO catalog_growth_runs (id, started_at, finished_at, genres_tried, inserted_count, error, created_at)
       VALUES (?, ?, ?, '[]', 0, ?, ?)`
    ).bind(id, now, Date.now(), message, now).run();

    if (env.OPS_ALERT_EMAIL) {
      await sendEmail(env, {
        to: env.OPS_ALERT_EMAIL,
        subject: 'Wavelengthz: artist catalog growth job failed',
        html: `<p>The scheduled artist catalog growth job failed:</p><pre>${message}</pre>`,
      }).catch(() => {});
    }
    throw error;
  }
}
```

- [ ] **Step 5: Enable Workers Logs and add the new vars to `wrangler.toml`**

Add a new top-level block (`wrangler.toml` currently has no `[observability]` block at all — this turns on persisted, queryable logs for this Worker in the Cloudflare dashboard, capturing the `console.log`/`console.error` calls added in Step 4 above for every invocation, cron included):

```toml
[observability]
enabled = true
```

In the `[vars]` block:

```toml
[vars]
SPOTIFY_REDIRECT_URI = "http://127.0.0.1:8787/callback"
MATCH_NOTIFICATION_DELAY_MINUTES = "5"
# Kill switch for the scheduled artist-catalog-growth job (src/lib/
# catalogGrowth.ts's runCatalogGrowthJob) -- set to "false" (via `wrangler
# secret put` or the dashboard) to pause it without a code deploy. Unset or
# any other value means enabled.
ARTIST_CATALOG_GROWTH_ENABLED = "true"
```

In the `[triggers]` block, add the new cron and update the comment:

```toml
[triggers]
# "0 3 * * *": nightly purgeExpiredDeletions. "0 4 * * sun": weekly catalog
# refresh -- Cloudflare's day-of-week is 1=Sunday..7=Saturday, NOT the usual
# 0=Sunday..6=Saturday, so the numeric form (e.g. "0") is a different day
# than it looks and can even be rejected outright as out of range; the
# 3-letter name Cloudflare itself recommends sidesteps the whole ambiguity.
# "*/5 * * * *": sweeps deferred match-notification emails
# (MATCH_NOTIFICATION_DELAY_MINUTES above). "*/15 * * * *": artist catalog
# growth (src/lib/catalogGrowth.ts's runCatalogGrowthJob).
crons = ["0 3 * * *", "0 4 * * sun", "*/5 * * * *", "*/15 * * * *"]
```

In the `[env.test.vars]` block, add:

```toml
ARTIST_CATALOG_GROWTH_ENABLED = "true"
OPS_ALERT_EMAIL = "ops@example.com"
```

- [ ] **Step 6: Regenerate `worker-configuration.d.ts` so the new `[vars]` entry is typed**

Run: `npx wrangler types`
Expected: `worker-configuration.d.ts` is rewritten with `ARTIST_CATALOG_GROWTH_ENABLED: string` included in the generated `Env`/`Cloudflare.Env` interfaces.

- [ ] **Step 7: Wire the new cron branch into `src/index.ts`**

Add the import alongside the existing scheduled-job imports:

```typescript
import { runCatalogGrowthJob } from './lib/catalogGrowth';
```

In the `scheduled` handler, add a new branch before the final `else`:

```typescript
    } else if (event.cron === '*/15 * * * *') {
      ctx.waitUntil(
        runCatalogGrowthJob(env, Date.now())
          .then(() => undefined)
          .catch(report('scheduled:runCatalogGrowthJob'))
      );
    } else {
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/lib/catalogGrowth.test.ts`
Expected: PASS (14/14)

- [ ] **Step 9: Commit**

```bash
git add src/lib/catalogGrowth.ts test/lib/catalogGrowth.test.ts src/env.d.ts wrangler.toml worker-configuration.d.ts src/index.ts
git commit -m "feat: add scheduled artist catalog growth job with enable flag and failure alerting"
```

---

### Task 4: Daily growth digest email

**Files:**
- Modify: `src/lib/catalogGrowth.ts`
- Modify: `test/lib/catalogGrowth.test.ts`
- Modify: `wrangler.toml`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `sendEmail` (`src/lib/email.ts`); `catalog_growth_runs` rows written by `runCatalogGrowthJob` (Task 3); reuses `env.OPS_ALERT_EMAIL` (Task 3).
- Produces: `sendCatalogGrowthDigest(env: Env, now: number): Promise<void>` from `src/lib/catalogGrowth.ts`.

- [ ] **Step 1: Write the failing tests for `sendCatalogGrowthDigest`**

Append to `test/lib/catalogGrowth.test.ts`:

```typescript
import { sendCatalogGrowthDigest } from '../../src/lib/catalogGrowth';

describe('sendCatalogGrowthDigest', () => {
  async function insertRun(id: string, createdAt: number, insertedCount: number, error: string | null) {
    await env.DB.prepare(
      `INSERT INTO catalog_growth_runs (id, started_at, finished_at, genres_tried, inserted_count, error, created_at)
       VALUES (?, ?, ?, '[]', ?, ?, ?)`
    ).bind(id, createdAt, createdAt, insertedCount, error, createdAt).run();
  }

  it('aggregates the last 24h of runs into one summary email', async () => {
    const now = 100 * 60 * 60 * 1000; // arbitrary "now" comfortably past 24h from epoch
    await insertRun('r1', now - 1000, 5, null);
    await insertRun('r2', now - 2000, 3, 'boom');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendCatalogGrowthDigest(env as any, now);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.html).toContain('8 new artist(s)');
    expect(body.html).toContain('1 failed run(s)');
    vi.unstubAllGlobals();
  });

  it('excludes runs older than 24h', async () => {
    const now = 100 * 60 * 60 * 1000;
    await insertRun('old', now - 25 * 60 * 60 * 1000, 99, null);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendCatalogGrowthDigest(env as any, now);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.html).toContain('0 new artist(s)');
    vi.unstubAllGlobals();
  });

  it('does nothing when OPS_ALERT_EMAIL is not configured', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendCatalogGrowthDigest({ ...env, OPS_ALERT_EMAIL: undefined } as any, 1000);

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/catalogGrowth.test.ts`
Expected: FAIL — `sendCatalogGrowthDigest` is not exported.

- [ ] **Step 3: Add `sendCatalogGrowthDigest` to `src/lib/catalogGrowth.ts`**

```typescript
/**
 * Reads catalog_growth_runs for the last 24h and emails one summary to
 * OPS_ALERT_EMAIL -- deliberately not a per-run email (the growth job runs
 * every 15 minutes; that would be 90+ emails/day). A no-op when
 * OPS_ALERT_EMAIL isn't configured, same as the failure path above.
 */
export async function sendCatalogGrowthDigest(env: Env, now: number): Promise<void> {
  if (!env.OPS_ALERT_EMAIL) return;

  const since = now - 24 * 60 * 60 * 1000;
  const rows = await env.DB.prepare(`SELECT inserted_count, error FROM catalog_growth_runs WHERE created_at >= ?`)
    .bind(since)
    .all<{ inserted_count: number; error: string | null }>();

  const totalInserted = rows.results.reduce((sum, r) => sum + r.inserted_count, 0);
  const runCount = rows.results.length;
  const failedCount = rows.results.filter((r) => r.error !== null).length;

  await sendEmail(env, {
    to: env.OPS_ALERT_EMAIL,
    subject: `Wavelengthz: artist catalog growth digest (${totalInserted} new artists today)`,
    html: `<p>${runCount} run(s) in the last 24h, ${totalInserted} new artist(s) inserted, ${failedCount} failed run(s).</p>`,
  });
}
```

- [ ] **Step 4: Add the digest cron to `wrangler.toml`**

Update the `[triggers]` block:

```toml
[triggers]
# "0 3 * * *": nightly purgeExpiredDeletions. "0 4 * * sun": weekly catalog
# refresh. "*/5 * * * *": sweeps deferred match-notification emails
# (MATCH_NOTIFICATION_DELAY_MINUTES above). "*/15 * * * *": artist catalog
# growth (src/lib/catalogGrowth.ts's runCatalogGrowthJob). "0 13 * * *":
# daily artist catalog growth digest email (sendCatalogGrowthDigest).
crons = ["0 3 * * *", "0 4 * * sun", "*/5 * * * *", "*/15 * * * *", "0 13 * * *"]
```

- [ ] **Step 5: Wire the new cron branch into `src/index.ts`**

Add the import alongside `runCatalogGrowthJob`:

```typescript
import { runCatalogGrowthJob, sendCatalogGrowthDigest } from './lib/catalogGrowth';
```

Add a new branch in `scheduled`, before the final `else`:

```typescript
    } else if (event.cron === '0 13 * * *') {
      ctx.waitUntil(
        sendCatalogGrowthDigest(env, Date.now())
          .then(() => undefined)
          .catch(report('scheduled:sendCatalogGrowthDigest'))
      );
    } else {
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/lib/catalogGrowth.test.ts`
Expected: PASS (17/17)

- [ ] **Step 7: Commit**

```bash
git add src/lib/catalogGrowth.ts test/lib/catalogGrowth.test.ts wrangler.toml src/index.ts
git commit -m "feat: add daily artist catalog growth digest email"
```

---

### Task 5: Simplify the reactive fallback in `musicSwipes.ts`; retire `artistTopUp.ts`

**Files:**
- Modify: `src/routes/musicSwipes.ts`
- Modify: `test/routes/musicSwipes.test.ts`
- Delete: `src/lib/artistTopUp.ts`
- Delete: `test/lib/artistTopUp.test.ts`

**Interfaces:**
- Consumes: `growArtistCatalog` (Task 2).
- Removes: `topUpArtistsForUser`, `topGenresForUser`, `TOP_UP_COUNT` (all from the deleted `artistTopUp.ts`), and `LOW_ARTIST_POOL_THRESHOLD` from `musicSwipes.ts` — the background (`ctx.waitUntil`, `remaining < 15`) top-up path is removed entirely; the cron job from Task 3 now owns that job.

- [ ] **Step 1: Delete the superseded module and its test**

```bash
git rm src/lib/artistTopUp.ts test/lib/artistTopUp.test.ts
```

- [ ] **Step 2: Remove the obsolete background-top-up test from `test/routes/musicSwipes.test.ts`**

Delete the entire `it('tops up in the background (ctx.waitUntil) once the pool is low but not yet empty, without delaying the response', ...)` block (currently lines 125-180) — that code path no longer exists.

- [ ] **Step 3: Run the music-swipe test suite to confirm it now fails to compile**

Run: `npx vitest run test/routes/musicSwipes.test.ts`
Expected: FAIL — `src/routes/musicSwipes.ts` still imports the now-deleted `../lib/artistTopUp`.

- [ ] **Step 4: Update `src/routes/musicSwipes.ts`**

Replace the import:

```typescript
import { topUpArtistsForUser } from '../lib/artistTopUp';
```

with:

```typescript
import { growArtistCatalog } from '../lib/catalogGrowth';
```

Delete the `LOW_ARTIST_POOL_THRESHOLD` constant (currently lines 66-68, just above `registerMusicSwipeRoutes`).

Replace the `GET /api/candidates/music` handler's signature and top-up block:

```typescript
  router.get('/api/candidates/music', async (request: Request, env: Env) => {
```

(dropping the now-unused `ctx: ExecutionContext` parameter), and replace this block:

```typescript
    // Never let a user permanently hit "no more candidates" in music mode.
    // Tracks aren't included in either path below: track candidates come
    // from artists already in the catalog, so topping up artists indirectly
    // grows track candidates too on a later run.
    if (itemType === 'artist') {
      const remainingRow = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM ${table}
         WHERE approved = 1 ${photoFilter} AND id NOT IN (
           SELECT item_id FROM music_swipes WHERE user_id = ? AND item_type = ?
         )`
      ).bind(user.id, itemType).first<{ c: number }>();
      const remaining = remainingRow?.c ?? 0;

      if (remaining === 0) {
        // Genuinely out right now -- top up synchronously so THIS request
        // doesn't come back empty (matters the very first time a user's pool
        // runs dry, before the background path below ever gets a chance to
        // run ahead of it).
        try {
          const inserted = await topUpArtistsForUser(env, user);
          if (inserted > 0) rows = await queryCandidates();
        } catch (error) {
          // A Spotify/token failure here must not turn an otherwise-successful
          // (if empty) candidates request into a 500 -- just serve what's there.
          console.error('topUpArtistsForUser failed', error);
        }
      } else if (remaining < LOW_ARTIST_POOL_THRESHOLD) {
        // Below the threshold but not empty yet: top up in the BACKGROUND via
        // ctx.waitUntil rather than blocking this response. The deck only
        // re-fetches once its local queue is fully drained (public/index.html's
        // decide()), so this gives the Spotify round-trip the user's remaining
        // swipe-throughs' worth of wall-clock time to finish -- hiding the
        // latency the synchronous-only version made visible right when
        // someone hit their last candidate.
        ctx.waitUntil(
          topUpArtistsForUser(env, user).catch((error) => console.error('background topUpArtistsForUser failed', error))
        );
      }
    }
```

with:

```typescript
    // Catalog growth is now primarily driven by the scheduled job
    // (src/lib/catalogGrowth.ts's runCatalogGrowthJob, wired in
    // src/index.ts's scheduled()). This is only a last-resort safety net
    // for the rare case a user's pool hits zero between runs -- bounded to
    // 2 real Spotify searches so a live request never pays for more than
    // that much added latency.
    if (itemType === 'artist') {
      const remainingRow = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM ${table}
         WHERE approved = 1 ${photoFilter} AND id NOT IN (
           SELECT item_id FROM music_swipes WHERE user_id = ? AND item_type = ?
         )`
      ).bind(user.id, itemType).first<{ c: number }>();
      const remaining = remainingRow?.c ?? 0;

      if (remaining === 0) {
        try {
          const growth = await growArtistCatalog(env, Date.now(), { maxInserted: 10, maxGenres: 2 });
          if (growth.inserted > 0) rows = await queryCandidates();
        } catch (error) {
          // A Spotify/token failure here must not turn an otherwise-successful
          // (if empty) candidates request into a 500 -- just serve what's there.
          console.error('growArtistCatalog (reactive fallback) failed', error);
        }
      }
    }
```

- [ ] **Step 5: Run the music-swipe test suite to verify it passes**

Run: `npx vitest run test/routes/musicSwipes.test.ts`
Expected: PASS — every remaining test green, including `'tops up the catalog from Spotify and returns fresh candidates once the local pool is exhausted'` (unchanged assertions; it exercises the new reactive-fallback code path transparently, since its Spotify stub returns a fresh artist for any genre queried).

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — every test file green, including `test/lib/catalogGrowth.test.ts` (Tasks 1-4) and every pre-existing file.

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/routes/musicSwipes.ts test/routes/musicSwipes.test.ts src/lib/artistTopUp.ts test/lib/artistTopUp.test.ts
git commit -m "refactor: retire per-user artist top-up in favor of the shared growth helper"
```
