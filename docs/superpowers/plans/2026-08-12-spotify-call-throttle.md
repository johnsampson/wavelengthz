# Spotify Call Throttling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop background Spotify work (the artist-track backfill queue, the deck's candidate top-up) from colliding with interactive page loads on Spotify's app-wide rate limit, without needing to know Spotify's actual limit.

**Architecture:** A new KV-backed "cooldown flag" (`src/lib/spotifyThrottle.ts`) gets set the instant any Spotify call sees a 429. Two functions that are always invoked in a background context (`fetchArtistTracks` when called with `'background'` priority, and `searchArtistsByGenre`) check that flag once, before doing any Spotify work, and bail out immediately if it's active — wasting zero Spotify calls piling onto existing pressure. Interactive calls (a real user waiting on a response) never check the flag and are protected only by the existing 429-retry-with-backoff loop. Background fan-outs also get two burst-shaping changes: they stop fetching further albums' track-lists once enough track ids are already gathered, and they pace their calls with a small delay instead of firing everything as fast as possible.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, KV (`RATE_LIMIT_KV`), Cloudflare Queues, Vitest with `@cloudflare/vitest-pool-workers` (`cloudflare:test`'s `env` gives real D1/KV backed by miniflare).

**Spec:** `docs/superpowers/specs/2026-08-12-spotify-call-throttle-design.md`

## Global Constraints

- Cloudflare KV requires `expirationTtl >= 60` seconds on every `put()` call. The cooldown's *real* duration (15s default, and most real `Retry-After` values) is shorter than that floor — the KV write's own `expirationTtl` must be floored to 60 for the write to succeed, but the actual "is cooldown still active" decision must come from comparing a stored expiry *timestamp* against `Date.now()`, never from relying on the KV row's own TTL.
- No `public/sw.js` / `APP_SHELL` / CSP changes anywhere in this plan — every change is server-side (`src/`) only.
- No new KV namespace, D1 migration, or wrangler.toml binding — everything reuses the existing `RATE_LIMIT_KV`.
- `SPOTIFY_COOLDOWN_DEFAULT_SECONDS = 15` and `SPOTIFY_BACKGROUND_PACING_DELAY_MS = 250` are explicit, named constants with comments flagging them as starting guesses (Spotify's real limit is undocumented) — never inline magic numbers.
- **Scope note:** `src/db/seed.ts` (the admin catalog-seed script) is not a named goal of this design (it's neither the backfill queue nor the deck top-up). Its `searchArtistsByGenre` call site is touched only because that function's signature becomes a hard compile requirement everywhere it's called; its `fetchArtistTracks` call site is deliberately left untouched (stays `'interactive'`/no-`kv`, identical to its behavior today) since both `priority` and `kv` are optional there with backward-compatible defaults.

---

## Task 1: `spotifyThrottle.ts` — the cooldown flag primitive

**Files:**
- Create: `src/lib/spotifyThrottle.ts`
- Test: `test/lib/spotifyThrottle.test.ts`

**Interfaces:**
- Produces: `markSpotifyCooldown(kv: KVNamespace, retryAfterSeconds?: number): Promise<void>` and `isSpotifyCoolingDown(kv: KVNamespace): Promise<number | null>` (remaining ms, or `null` if not active). Every later task imports these from `../lib/spotifyThrottle` (or `./spotifyThrottle` from within `src/lib/`).

- [ ] **Step 1: Write the failing tests**

Create `test/lib/spotifyThrottle.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { markSpotifyCooldown, isSpotifyCoolingDown } from '../../src/lib/spotifyThrottle';

beforeEach(async () => {
  const list = await env.RATE_LIMIT_KV.list();
  await Promise.all(list.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
});

describe('isSpotifyCoolingDown', () => {
  it('returns null when no cooldown has ever been set', async () => {
    expect(await isSpotifyCoolingDown(env.RATE_LIMIT_KV)).toBeNull();
  });
});

describe('markSpotifyCooldown / isSpotifyCoolingDown', () => {
  it('reports an active cooldown with a positive remaining-ms after marking with a specific Retry-After', async () => {
    await markSpotifyCooldown(env.RATE_LIMIT_KV, 5);

    const remaining = await isSpotifyCoolingDown(env.RATE_LIMIT_KV);

    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(0);
    expect(remaining!).toBeLessThanOrEqual(5000);
  });

  it('falls back to the default duration when no Retry-After is given', async () => {
    await markSpotifyCooldown(env.RATE_LIMIT_KV);

    const remaining = await isSpotifyCoolingDown(env.RATE_LIMIT_KV);

    expect(remaining).not.toBeNull();
    // SPOTIFY_COOLDOWN_DEFAULT_SECONDS = 15
    expect(remaining!).toBeGreaterThan(14000);
    expect(remaining!).toBeLessThanOrEqual(15000);
  });

  it('ignores a non-positive or non-finite Retry-After, falling back to the default', async () => {
    await markSpotifyCooldown(env.RATE_LIMIT_KV, -1);

    const remaining = await isSpotifyCoolingDown(env.RATE_LIMIT_KV);

    expect(remaining!).toBeGreaterThan(14000);
    expect(remaining!).toBeLessThanOrEqual(15000);
  });

  it("correctly reports cooldown cleared once the real (short) duration has elapsed, even though the underlying KV row -- floored to Cloudflare's 60s minimum -- has not", async () => {
    // A fractional Retry-After keeps this test fast while still exercising
    // the real gap between the intended ~10ms duration and the KV row's
    // own 60s-floored expirationTtl.
    await markSpotifyCooldown(env.RATE_LIMIT_KV, 0.01);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await isSpotifyCoolingDown(env.RATE_LIMIT_KV)).toBeNull();
    // The KV row itself is still there (60s floor) -- only the *reported*
    // cooldown state has cleared, proving isSpotifyCoolingDown reads the
    // stored expiry rather than relying on the KV row's own TTL.
    expect(await env.RATE_LIMIT_KV.get('spotify-cooldown')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/spotifyThrottle.test.ts`
Expected: FAIL with "Cannot find module '../../src/lib/spotifyThrottle'" (or similar module-not-found).

- [ ] **Step 3: Write the implementation**

Create `src/lib/spotifyThrottle.ts`:

```ts
const SPOTIFY_COOLDOWN_KV_KEY = 'spotify-cooldown';
// Conservative starting guess -- roughly half of the ~30s rolling window
// implied by production Sentry reports (SpotifyRateLimitError even after 3
// retries on GET /v1/albums/{id}/tracks). Spotify's real window/threshold
// isn't documented -- tune this from observed data as it comes in.
const SPOTIFY_COOLDOWN_DEFAULT_SECONDS = 15;

// Cloudflare KV requires expirationTtl >= 60s -- longer than the intended
// cooldown (15s default, and most real Retry-After values). Floored here
// purely so the row eventually self-cleans; it is NOT the signal
// isSpotifyCoolingDown uses -- that compares the stored expiry timestamp
// (the real, possibly-shorter duration) against Date.now(), so cooldown
// correctly clears after the intended duration even though the underlying
// KV row can persist up to 60s.
const KV_MIN_EXPIRATION_TTL_SECONDS = 60;

export async function markSpotifyCooldown(kv: KVNamespace, retryAfterSeconds?: number): Promise<void> {
  const validRetryAfter =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds
      : SPOTIFY_COOLDOWN_DEFAULT_SECONDS;
  const expiresAt = Date.now() + Math.round(validRetryAfter * 1000);
  await kv.put(SPOTIFY_COOLDOWN_KV_KEY, String(expiresAt), {
    expirationTtl: Math.max(Math.ceil(validRetryAfter), KV_MIN_EXPIRATION_TTL_SECONDS),
  });
}

export async function isSpotifyCoolingDown(kv: KVNamespace): Promise<number | null> {
  const stored = await kv.get(SPOTIFY_COOLDOWN_KV_KEY);
  if (stored === null) return null;
  const remaining = Number(stored) - Date.now();
  return remaining > 0 ? remaining : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/spotifyThrottle.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/spotifyThrottle.ts test/lib/spotifyThrottle.test.ts
git commit -m "feat: add spotifyThrottle -- app-wide Spotify cooldown flag in KV"
```

---

## Task 2: `SpotifyCooldownActiveError` + `kv` threading through low-level Spotify fetch helpers

**Files:**
- Modify: `src/lib/spotify.ts`
- Test: `test/lib/spotify.test.ts`

**Interfaces:**
- Consumes: `markSpotifyCooldown` from Task 1 (`./spotifyThrottle`).
- Produces: `SpotifyCooldownActiveError` (exported class, `remainingMs: number` property). `spotifyFetch(url, options, kv?: KVNamespace)` now writes the cooldown flag on a 429 when `kv` is provided. `fetchArtistAlbumIds`, `fetchAlbumTrackIds`, `fetchTracksByIds` (internal) and `fetchTrackById` (exported) all gain an optional trailing `kv?: KVNamespace` parameter, forwarded to `spotifyFetch`. `mapWithConcurrency` gains an optional trailing `delayMs = 0` parameter (unused with a real value until Task 3, but the signature change belongs here alongside `fetchTracksByIds`, its only caller that will ever pass one).
- This task does **not** touch `fetchArtistTracks`, `fetchArtistTracksQuick`, `searchArtistsByGenre`, or any call site outside `spotify.ts` -- every existing caller of the functions touched here keeps compiling unchanged, since the new parameters are all optional/defaulted.

- [ ] **Step 1: Write the failing tests**

In `test/lib/spotify.test.ts`, update the import block at the top of the file:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  buildAuthUrl,
  fetchSpotifyProfile,
  fetchArtistTracks,
  fetchArtistTracksQuick,
  QUICK_TRACK_LIMIT,
  fetchArtistById,
  fetchTrackById,
  SpotifyRateLimitError,
} from '../../src/lib/spotify';
```

(only change: added `fetchTrackById` to the import list)

Add this helper near the top of the file, after the `env` constant (around line 15):

```ts
function fakeKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}
```

Add a new `describe` block at the end of the file, after the existing `describe('spotifyFetch (retry-on-429, via fetchArtistById)', ...)` block:

```ts
// A separate block from the one above (which exercises retry behavior via
// fetchArtistById, a function that never gets a kv param) -- kv-forwarding
// and cooldown-marking are new behavior only reachable through the
// functions in this file that DO take kv, and fetchTrackById is the
// simplest of those.
describe('spotifyFetch cooldown-marking on 429 (via fetchTrackById)', () => {
  it('marks the cooldown flag, honoring Retry-After (not falling back to the default), when a kv is provided and a 429 occurs', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
        return new Response(JSON.stringify({ id: 'track-1', name: 'Song', artists: [] }), { status: 200 });
      })
    );
    const kv = fakeKv();
    const before = Date.now();

    await fetchTrackById('token', 'track-1', kv);

    const stored = await kv.get('spotify-cooldown');
    expect(stored).not.toBeNull();
    const expiresInFromBefore = Number(stored) - before;
    // Retry-After: 1s should drive this to ~1s out from `before`, clearly
    // distinct from SPOTIFY_COOLDOWN_DEFAULT_SECONDS (15s) -- proving the
    // header value was actually read, not the fallback used.
    expect(expiresInFromBefore).toBeGreaterThan(500);
    expect(expiresInFromBefore).toBeLessThan(10000);
    vi.unstubAllGlobals();
  }, 5000);

  it('does not touch KV at all when no kv is provided -- existing (pre-throttle) call sites are unaffected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.001' } }))
    );
    const kv = fakeKv();
    const putSpy = vi.spyOn(kv, 'put');

    await expect(fetchTrackById('token', 'track-1')).rejects.toThrow(SpotifyRateLimitError);

    expect(putSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not mark cooldown on a successful (non-429) response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'track-1', name: 'Song', artists: [] }), { status: 200 }))
    );
    const kv = fakeKv();

    await fetchTrackById('token', 'track-1', kv);

    expect(await kv.get('spotify-cooldown')).toBeNull();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/spotify.test.ts`
Expected: FAIL — `fetchTrackById` doesn't accept a 3rd argument yet (TypeScript error) and `spotify-cooldown` is never written.

- [ ] **Step 3: Write the implementation**

In `src/lib/spotify.ts`, add this import at the top of the file (after the existing content, before `SpotifyTokenResponse`... actually as the very first line, above the `SpotifyTokenResponse` interface):

```ts
import { markSpotifyCooldown } from './spotifyThrottle';

export interface SpotifyTokenResponse {
```

Immediately after the existing `SpotifyRateLimitError` class (currently lines 19-24), add:

```ts

// Thrown by fetchArtistTracks/searchArtistsByGenre (never by spotifyFetch
// itself) when a 'background'-priority call is skipped because
// isSpotifyCoolingDown (src/lib/spotifyThrottle.ts) reports an active
// cooldown -- meaning this call was never even attempted, unlike
// SpotifyRateLimitError which means Spotify was actually asked and said no
// after real retries. src/lib/artistTrackBackfill.ts's queue consumer
// checks for this specifically to retry with a delay matching the
// remaining cooldown instead of the default immediate retry every other
// error gets.
export class SpotifyCooldownActiveError extends Error {
  remainingMs: number;
  constructor(remainingMs: number) {
    super(`Skipping Spotify call -- app-wide cooldown active for another ${Math.ceil(remainingMs / 1000)}s`);
    this.name = 'SpotifyCooldownActiveError';
    this.remainingMs = remainingMs;
  }
}
```

Replace the existing `spotifyFetch` function (lines 55-75) with:

```ts
async function spotifyFetch(url: string, options: RequestInit = {}, kv?: KVNamespace): Promise<Response> {
  let res = await fetch(url, options);

  // Reported the moment ANY call actually sees a 429 -- the earliest, most
  // actionable signal that Spotify is currently constrained -- before this
  // function's own retry loop even runs. Only when a kv is provided: the
  // handful of Spotify calls outside the artist-tracks fan-out
  // (login/profile/top-tracks/single-item search) don't pass one and keep
  // their exact pre-existing behavior.
  if (res.status === 429 && kv) {
    const retryAfterHeader = res.headers.get('Retry-After');
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    await markSpotifyCooldown(kv, retryAfterSeconds);
  }

  for (let attempt = 0; attempt < SPOTIFY_MAX_RETRIES && res.status === 429; attempt++) {
    const retryAfterHeader = res.headers.get('Retry-After');
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const delayMs = Math.min(
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : SPOTIFY_RETRY_DEFAULT_DELAY_MS * 2 ** attempt,
      SPOTIFY_RETRY_MAX_DELAY_MS
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res = await fetch(url, options);
  }

  if (res.status === 429) {
    throw new SpotifyRateLimitError(`Spotify rate-limited this request even after ${SPOTIFY_MAX_RETRIES} retries: ${url}`);
  }
  return res;
}
```

Replace `mapWithConcurrency` (lines 95-106) with:

```ts
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>, delayMs = 0): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
      if (delayMs > 0 && nextIndex < items.length) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
```

Replace `fetchArtistAlbumIds` (lines 308-319) with:

```ts
async function fetchArtistAlbumIds(token: string, artistId: string, limit: number, kv?: KVNamespace): Promise<string[]> {
  const res = await spotifyFetch(
    // include_groups excludes "compilation" and "appears_on" -- releases
    // where this artist isn't the actual album artist, which is exactly the
    // ambiguity this replaces the name-search fallback to avoid.
    `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single&limit=${Math.min(limit, ARTIST_ALBUMS_PAGE_SIZE)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    kv
  );
  if (!res.ok) throw new Error(`Spotify artist albums fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ items: Array<{ id: string }> }>();
  return data.items.map((album) => album.id);
}
```

Replace `fetchAlbumTrackIds` (lines 321-328) with:

```ts
async function fetchAlbumTrackIds(token: string, albumId: string, limit: number, kv?: KVNamespace): Promise<string[]> {
  const res = await spotifyFetch(
    `https://api.spotify.com/v1/albums/${albumId}/tracks?limit=${Math.min(limit, ALBUM_TRACKS_PAGE_SIZE)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    kv
  );
  if (!res.ok) throw new Error(`Spotify album tracks fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ items: Array<{ id: string }> }>();
  return data.items.map((track) => track.id);
}
```

Replace `fetchTracksByIds` (lines 330-346) with:

```ts
async function fetchTracksByIds(token: string, trackIds: string[], kv?: KVNamespace, delayMs = 0) {
  // GET /v1/albums/{id}/tracks returns simplified track objects with no
  // `album` field, so no album art -- full details come from fetchTrackById
  // instead. The batch form of this lookup (GET /v1/tracks?ids=, plural)
  // also 403s in Development Mode -- confirmed live, even with a single id
  // -- while the singular GET /v1/tracks/{id} used here works fine, so this
  // is one request per track rather than one batch request. Bounded by
  // TRACK_FETCH_CONCURRENCY (see its own comment) rather than one giant
  // Promise.all -- with no batch endpoint available, a large track count
  // (up to ARTIST_PROFILE_TRACK_MAX_LIMIT) firing every request at once was
  // the single biggest contributor to tripping Spotify's own rate limit.
  // One id failing (removed/region-locked track) shouldn't drop the rest of
  // the artist's tracks, so each fetch is isolated via .catch rather than
  // one throw wiping out the whole batch.
  const results = await mapWithConcurrency(
    trackIds,
    TRACK_FETCH_CONCURRENCY,
    (id) => fetchTrackById(token, id, kv).catch(() => null),
    delayMs
  );
  return results.filter((track): track is NonNullable<typeof track> => track != null);
}
```

Replace `fetchTrackById` (lines 425-431, near the end of the file) with:

```ts
export async function fetchTrackById(token: string, trackId: string, kv?: KVNamespace) {
  const res = await spotifyFetch(
    `https://api.spotify.com/v1/tracks/${trackId}`,
    { headers: { Authorization: `Bearer ${token}` } },
    kv
  );
  if (!res.ok) throw new Error(`Spotify track fetch failed: ${res.status} ${await res.text()}`);
  return res.json<any>();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/spotify.test.ts`
Expected: PASS (all existing tests + 3 new ones in the new describe block)

- [ ] **Step 5: Run the full suite to confirm no regressions elsewhere**

Run: `npm test`
Expected: PASS (845 + new tests, 0 failures) — `fetchArtistTracks`, `fetchArtistTracksQuick`, and every route/queue test still call the touched functions with their old argument counts, which remain valid since the new parameters are optional.

- [ ] **Step 6: Commit**

```bash
git add src/lib/spotify.ts test/lib/spotify.test.ts
git commit -m "feat: thread optional kv through spotifyFetch and its low-level helpers"
```

---

## Task 3: `fetchArtistTracks` priority-aware admission + background burst-shaping

**Files:**
- Modify: `src/lib/spotify.ts`
- Test: `test/lib/spotify.test.ts`

**Interfaces:**
- Consumes: `isSpotifyCoolingDown` (Task 1), `SpotifyCooldownActiveError` (Task 2), `mapWithConcurrency`'s `delayMs` param (Task 2).
- Produces: `fetchArtistTracks(token, artistId, limit, priority: 'interactive' | 'background' = 'interactive', kv?: KVNamespace)`. Existing 3-arg callers (`seed.ts`, and every current test) are unaffected -- default priority is `'interactive'`, identical behavior to today.
- This task does not touch any call site outside `spotify.ts`.

- [ ] **Step 1: Write the failing tests**

In `test/lib/spotify.test.ts`, add `SpotifyCooldownActiveError` to the import list (it now becomes:

```ts
import {
  buildAuthUrl,
  fetchSpotifyProfile,
  fetchArtistTracks,
  fetchArtistTracksQuick,
  QUICK_TRACK_LIMIT,
  fetchArtistById,
  fetchTrackById,
  SpotifyRateLimitError,
  SpotifyCooldownActiveError,
} from '../../src/lib/spotify';
```

Add these tests inside the existing `describe('fetchArtistTracks', ...)` block (after the last existing `it(...)`, before its closing `});` around line 315):

```ts
  it('throws SpotifyCooldownActiveError, without making any Spotify call, when background priority is used during an active cooldown', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const kv = fakeKv({ 'spotify-cooldown': String(Date.now() + 10000) });

    await expect(fetchArtistTracks('token', 'artist-1', 10, 'background', kv)).rejects.toThrow(SpotifyCooldownActiveError);

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('proceeds normally with background priority when there is no active cooldown', async () => {
    stubSpotify({
      albums: [{ id: 'album-1' }],
      albumTracks: { 'album-1': [{ id: 't1' }] },
      tracksById: { t1: { id: 't1', name: 'Track One', artists: [{ id: 'artist-1' }] } },
    });
    const kv = fakeKv();

    const tracks = await fetchArtistTracks('token', 'artist-1', 10, 'background', kv);

    expect(tracks.map((t: any) => t.id)).toEqual(['t1']);
    vi.unstubAllGlobals();
  });

  it('interactive priority ignores an active cooldown entirely and still fetches', async () => {
    stubSpotify({
      albums: [{ id: 'album-1' }],
      albumTracks: { 'album-1': [{ id: 't1' }] },
      tracksById: { t1: { id: 't1', name: 'Track One', artists: [{ id: 'artist-1' }] } },
    });
    const kv = fakeKv({ 'spotify-cooldown': String(Date.now() + 10000) });

    const tracks = await fetchArtistTracks('token', 'artist-1', 10, 'interactive', kv);

    expect(tracks.map((t: any) => t.id)).toEqual(['t1']);
    vi.unstubAllGlobals();
  });

  it('background priority stops fetching further albums once enough track ids are already gathered', async () => {
    // 8 albums, each with 10 tracks -- the first ALBUM_TRACKS_FETCH_CONCURRENCY
    // (5) albums alone already yield 50 track ids, well past a limit of 30,
    // so the remaining 3 albums' track-lists should never be requested.
    const albumIds = Array.from({ length: 8 }, (_, i) => `album-${i}`);
    const albumTrackCalls = new Set<string>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: albumIds.map((id) => ({ id })) }), { status: 200 });
        }
        const albumMatch = url.match(/\/albums\/([^/?]+)\/tracks/);
        if (albumMatch) {
          albumTrackCalls.add(albumMatch[1]);
          const tracks = Array.from({ length: 10 }, (_, i) => ({ id: `${albumMatch[1]}-t${i}` }));
          return new Response(JSON.stringify({ items: tracks }), { status: 200 });
        }
        if (url.includes('/v1/tracks/')) {
          const id = url.match(/\/v1\/tracks\/([^/?]+)$/)![1];
          return new Response(JSON.stringify({ id, name: id, artists: [{ id: 'artist-1' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );
    const kv = fakeKv();

    await fetchArtistTracks('token', 'artist-1', 30, 'background', kv);

    expect(albumTrackCalls.size).toBe(5); // not all 8
    vi.unstubAllGlobals();
  }, 10000);

  it("interactive priority still fetches every album's track-list up front (regression check against the background-only early-stop)", async () => {
    const albumIds = Array.from({ length: 8 }, (_, i) => `album-${i}`);
    const albumTrackCalls = new Set<string>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: albumIds.map((id) => ({ id })) }), { status: 200 });
        }
        const albumMatch = url.match(/\/albums\/([^/?]+)\/tracks/);
        if (albumMatch) {
          albumTrackCalls.add(albumMatch[1]);
          const tracks = Array.from({ length: 10 }, (_, i) => ({ id: `${albumMatch[1]}-t${i}` }));
          return new Response(JSON.stringify({ items: tracks }), { status: 200 });
        }
        if (url.includes('/v1/tracks/')) {
          const id = url.match(/\/v1\/tracks\/([^/?]+)$/)![1];
          return new Response(JSON.stringify({ id, name: id, artists: [{ id: 'artist-1' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    await fetchArtistTracks('token', 'artist-1', 30);

    expect(albumTrackCalls.size).toBe(8); // all of them, unlike background priority
    vi.unstubAllGlobals();
  }, 10000);

  it('paces background-priority calls with a delay, unlike interactive priority', async () => {
    const albumIds = ['album-1', 'album-2', 'album-3', 'album-4', 'album-5', 'album-6'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: albumIds.map((id) => ({ id })) }), { status: 200 });
        }
        if (url.includes('/albums/')) {
          // Each album has just 1 track, so even the first 5-album chunk
          // alone (5 tracks) doesn't satisfy a limit of 10 -- forces a
          // second chunk, which is where the pacing delay applies.
          const albumMatch = url.match(/\/albums\/([^/?]+)\/tracks/)!;
          return new Response(JSON.stringify({ items: [{ id: `${albumMatch[1]}-t1` }] }), { status: 200 });
        }
        if (url.includes('/v1/tracks/')) {
          const id = url.match(/\/v1\/tracks\/([^/?]+)$/)![1];
          return new Response(JSON.stringify({ id, name: id, artists: [{ id: 'artist-1' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );
    const kv = fakeKv();

    const start = Date.now();
    await fetchArtistTracks('token', 'artist-1', 10, 'background', kv);
    const elapsed = Date.now() - start;

    // SPOTIFY_BACKGROUND_PACING_DELAY_MS = 250 -- at least one pacing wait
    // fires (between the two album-list chunks, and/or in the track-detail
    // phase), so elapsed time should clear a meaningful fraction of one delay.
    expect(elapsed).toBeGreaterThanOrEqual(240);
    vi.unstubAllGlobals();
  }, 10000);

  it('applies no pacing delay for interactive priority', async () => {
    stubSpotify({
      albums: [{ id: 'album-1' }],
      albumTracks: { 'album-1': [{ id: 't1' }] },
      tracksById: { t1: { id: 't1', name: 'Track One', artists: [{ id: 'artist-1' }] } },
    });

    const start = Date.now();
    await fetchArtistTracks('token', 'artist-1', 10);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/spotify.test.ts`
Expected: FAIL — `fetchArtistTracks` doesn't accept a 4th/5th argument yet, no admission check exists, no early-stop/pacing exists.

- [ ] **Step 3: Write the implementation**

In `src/lib/spotify.ts`, add `isSpotifyCoolingDown` to the existing throttle import (from Task 2):

```ts
import { markSpotifyCooldown, isSpotifyCoolingDown } from './spotifyThrottle';
```

Replace the existing `fetchArtistTracks` function (lines 348-369) with:

```ts
// Conservative starting guess for spacing out a background-priority
// fan-out's individual Spotify calls -- same total call count as today, but
// spread over more wall-clock time so it doesn't cluster inside whatever
// Spotify's real rolling rate-limit window turns out to be (see
// src/lib/spotifyThrottle.ts's own comment). Interactive-priority calls
// never use this -- a real user is waiting on those.
const SPOTIFY_BACKGROUND_PACING_DELAY_MS = 250;

// Only used for 'background'-priority fetchArtistTracks calls (the backfill
// queue consumer, the deck's candidate top-up) -- fetches albums' track-ID
// lists in ALBUM_TRACKS_FETCH_CONCURRENCY-sized chunks instead of one
// mapWithConcurrency call across all (up to 10) albums, stopping as soon as
// `limit` track ids have been gathered. The interactive branch below
// deliberately keeps fetching everything up front (see its own comment) --
// this early-stop only makes sense once nothing is waiting on the result.
async function gatherAlbumTrackIdsForBackground(
  token: string,
  albumIds: string[],
  limit: number,
  kv: KVNamespace | undefined
): Promise<string[]> {
  const collected: string[] = [];
  for (let i = 0; i < albumIds.length && collected.length < limit; i += ALBUM_TRACKS_FETCH_CONCURRENCY) {
    const chunk = albumIds.slice(i, i + ALBUM_TRACKS_FETCH_CONCURRENCY);
    const chunkResults = await mapWithConcurrency(chunk, ALBUM_TRACKS_FETCH_CONCURRENCY, (albumId) =>
      fetchAlbumTrackIds(token, albumId, limit, kv)
    );
    collected.push(...chunkResults.flat());
    const hasMoreAlbums = i + ALBUM_TRACKS_FETCH_CONCURRENCY < albumIds.length;
    if (collected.length < limit && hasMoreAlbums) {
      await new Promise((resolve) => setTimeout(resolve, SPOTIFY_BACKGROUND_PACING_DELAY_MS));
    }
  }
  return collected;
}

export async function fetchArtistTracks(
  token: string,
  artistId: string,
  limit: number,
  priority: 'interactive' | 'background' = 'interactive',
  kv?: KVNamespace
) {
  if (priority === 'background') {
    if (!kv) throw new Error('fetchArtistTracks: kv is required when priority is "background"');
    const cooldownMs = await isSpotifyCoolingDown(kv);
    if (cooldownMs !== null) throw new SpotifyCooldownActiveError(cooldownMs);
  }

  // Fetched in parallel, not stopping early once enough tracks are found in
  // earlier albums -- a handful of extra album-tracks calls (bounded by
  // ARTIST_ALBUMS_PAGE_SIZE, at most 10) is a better trade than sequential
  // round trips directly adding to page load latency. Still capped by the
  // caller's own `limit` too (via fetchArtistAlbumIds's Math.min), so a
  // small target -- e.g. artistTopUp.ts's TRACKS_PER_ARTIST -- doesn't fan
  // out to 10 albums' worth of calls just to keep 2 tracks. Album order
  // (most recent release first -- see the module comment above) is
  // preserved via .flat(), so the truncation below still favors newer
  // releases. This trade-off (fetch everything up front) is interactive-only
  // -- 'background' priority uses gatherAlbumTrackIdsForBackground instead,
  // since nothing is waiting on a background job's latency.
  const albumIds = await fetchArtistAlbumIds(token, artistId, limit, kv);

  let trackIds: string[];
  if (priority === 'background') {
    trackIds = (await gatherAlbumTrackIdsForBackground(token, albumIds, limit, kv)).slice(0, limit);
  } else {
    const albumTrackIdLists = await mapWithConcurrency(albumIds, ALBUM_TRACKS_FETCH_CONCURRENCY, (albumId) =>
      fetchAlbumTrackIds(token, albumId, limit, kv)
    );
    trackIds = albumTrackIdLists.flat().slice(0, limit);
  }

  const tracks = await fetchTracksByIds(token, trackIds, kv, priority === 'background' ? SPOTIFY_BACKGROUND_PACING_DELAY_MS : 0);
  // Belt-and-suspenders: a release where this artist is the album artist
  // should credit them on every track, but this costs nothing and matches
  // the same defensive check the old search-based path needed for real.
  return tracks.filter((track) => track.artists?.some((a: any) => a.id === artistId));
}
```

**Note:** `SpotifyCooldownActiveError` must be defined (Task 2) *before* this function in the file for it to be in scope — since it's already added near the top of the file in Task 2, no reordering is needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/spotify.test.ts`
Expected: PASS (all existing + new tests)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/lib/spotify.ts test/lib/spotify.test.ts
git commit -m "feat: priority-aware admission + burst-shaping for fetchArtistTracks"
```

---

## Task 4: `fetchArtistTracksQuick` kv threading

**Files:**
- Modify: `src/lib/spotify.ts`
- Test: `test/lib/spotify.test.ts`

**Interfaces:**
- Consumes: `fetchArtistAlbumIds`, `fetchAlbumTrackIds`, `fetchTracksByIds` (all now taking optional `kv`, from Task 2).
- Produces: `fetchArtistTracksQuick(token, artistId, kv?: KVNamespace, trackCount: number = QUICK_TRACK_LIMIT)`. No existing call site (`src/routes/catalog.ts`, or any test) currently passes a 3rd argument, so this reordering is compile-safe everywhere until Task 6 explicitly wires `catalog.ts`'s call site.

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing `describe('fetchArtistTracksQuick', ...)` block in `test/lib/spotify.test.ts` (after the last existing `it(...)`, before its closing `});`):

```ts
  it('forwards kv through to spotifyFetch so a 429 still marks cooldown, even though quick fetch never checks it (always interactive)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: [{ id: 'album-1' }] }), { status: 200 });
        }
        if (url.includes('/albums/album-1/tracks')) {
          calls += 1;
          if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );
    const kv = fakeKv();

    await fetchArtistTracksQuick('token', 'artist-1', kv);

    expect(await kv.get('spotify-cooldown')).not.toBeNull();
    vi.unstubAllGlobals();
  }, 5000);

  it('still ignores an active cooldown and fetches anyway -- quick fetch is always interactive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('/artists/') && url.includes('/albums')) {
          return new Response(JSON.stringify({ items: [{ id: 'album-1' }] }), { status: 200 });
        }
        if (url.includes('/albums/album-1/tracks')) {
          return new Response(JSON.stringify({ items: [{ id: 't1' }] }), { status: 200 });
        }
        if (url.includes('/v1/tracks/t1')) {
          return new Response(JSON.stringify({ id: 't1', name: 'Track One', artists: [{ id: 'artist-1' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      })
    );
    const kv = fakeKv({ 'spotify-cooldown': String(Date.now() + 10000) });

    const tracks = await fetchArtistTracksQuick('token', 'artist-1', kv);

    expect(tracks).toHaveLength(1);
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/spotify.test.ts`
Expected: FAIL — `fetchArtistTracksQuick` doesn't accept a `kv` argument yet, so it's never forwarded and `spotify-cooldown` is never written.

- [ ] **Step 3: Write the implementation**

Replace the existing `fetchArtistTracksQuick` function (lines 382-394) with:

```ts
export async function fetchArtistTracksQuick(
  token: string,
  artistId: string,
  kv?: KVNamespace,
  trackCount: number = QUICK_TRACK_LIMIT
) {
  const albumIds = await fetchArtistAlbumIds(token, artistId, QUICK_ALBUM_LIMIT, kv);
  if (albumIds.length === 0) return [];

  // Sliced client-side after the call, not just trusted to the endpoint's
  // own `?limit=` (which fetchAlbumTrackIds does pass) -- keeps this
  // function's actual Spotify-call count deterministic regardless of how
  // many tracks come back, the same defense-in-depth reasoning as
  // fetchArtistTracks' own `.slice(0, limit)` above.
  const trackIds = (await fetchAlbumTrackIds(token, albumIds[0], trackCount, kv)).slice(0, trackCount);
  const tracks = await fetchTracksByIds(token, trackIds, kv);
  return tracks.filter((track) => track.artists?.some((a: any) => a.id === artistId));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/spotify.test.ts`
Expected: PASS (all existing + 2 new tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/spotify.ts test/lib/spotify.test.ts
git commit -m "feat: thread kv through fetchArtistTracksQuick"
```

---

## Task 5: `searchArtistsByGenre` admission check + minimal call-site updates

**Files:**
- Modify: `src/lib/spotify.ts`
- Modify: `src/lib/artistTopUp.ts:51`
- Modify: `src/db/seed.ts:89`
- Test: `test/lib/spotify.test.ts`

**Interfaces:**
- Consumes: `isSpotifyCoolingDown` (Task 1), `SpotifyCooldownActiveError` (Task 2), `markSpotifyCooldown` write path (Task 2, via `spotifyFetch`'s existing `kv` param).
- Produces: `searchArtistsByGenre(token, genre, limit, offset, kv: KVNamespace)` — `kv` is now a required 5th argument (this function is *always* background-priority; there is no interactive caller). Both real call sites are updated in this task so the codebase compiles.

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `test/lib/spotify.test.ts`, after the `fetchArtistTracksQuick` block and before the `spotifyFetch (retry-on-429, via fetchArtistById)` block. Also add `searchArtistsByGenre` to the top-of-file import list:

```ts
import {
  buildAuthUrl,
  fetchSpotifyProfile,
  fetchArtistTracks,
  fetchArtistTracksQuick,
  QUICK_TRACK_LIMIT,
  fetchArtistById,
  fetchTrackById,
  searchArtistsByGenre,
  SpotifyRateLimitError,
  SpotifyCooldownActiveError,
} from '../../src/lib/spotify';
```

```ts
describe('searchArtistsByGenre', () => {
  it("returns Spotify's results when there is no active cooldown", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ artists: { items: [{ id: 'a1', name: 'Artist One' }] } }), { status: 200 }))
    );
    const kv = fakeKv();

    const artists = await searchArtistsByGenre('token', 'indie', 10, 0, kv);

    expect(artists).toEqual([{ id: 'a1', name: 'Artist One' }]);
    vi.unstubAllGlobals();
  });

  it('throws SpotifyCooldownActiveError, without making any Spotify call, during an active cooldown', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const kv = fakeKv({ 'spotify-cooldown': String(Date.now() + 10000) });

    await expect(searchArtistsByGenre('token', 'indie', 10, 0, kv)).rejects.toThrow(SpotifyCooldownActiveError);

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/spotify.test.ts`
Expected: FAIL — `searchArtistsByGenre` doesn't accept a `kv` argument yet, and TypeScript will also flag the now-mismatched call.

- [ ] **Step 3: Write the implementation**

Replace the existing `searchArtistsByGenre` function (lines 263-271) with:

```ts
export async function searchArtistsByGenre(token: string, genre: string, limit: number, offset: number, kv: KVNamespace) {
  const cooldownMs = await isSpotifyCoolingDown(kv);
  if (cooldownMs !== null) throw new SpotifyCooldownActiveError(cooldownMs);

  const res = await spotifyFetch(
    `https://api.spotify.com/v1/search?type=artist&limit=${limit}&offset=${offset}&q=${encodeURIComponent(`genre:"${genre}"`)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    kv
  );
  if (!res.ok) throw new Error(`Spotify artist search failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ artists: { items: any[] } }>();
  return data.artists.items;
}
```

In `src/lib/artistTopUp.ts`, update line 51:

```ts
        artists = await searchArtistsByGenre(token, genre, 10, offset, env.RATE_LIMIT_KV);
```

(was: `artists = await searchArtistsByGenre(token, genre, 10, offset);`)

In `src/db/seed.ts`, update line 89:

```ts
        artists = await searchArtistsByGenre(token, genre, SEARCH_PAGE_SIZE, offset, env.RATE_LIMIT_KV);
```

(was: `artists = await searchArtistsByGenre(token, genre, SEARCH_PAGE_SIZE, offset);`)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/spotify.test.ts`
Expected: PASS (all existing + 2 new tests)

- [ ] **Step 5: Run the full suite (confirms `artistTopUp.test.ts` and `seed.test.ts` still pass unmodified)**

Run: `npm test`
Expected: PASS, 0 failures. Neither test file stubs a 429 anywhere, so `env.RATE_LIMIT_KV` starts cooldown-free in every test and `searchArtistsByGenre`'s new admission check never fires there.

- [ ] **Step 6: Commit**

```bash
git add src/lib/spotify.ts src/lib/artistTopUp.ts src/db/seed.ts test/lib/spotify.test.ts
git commit -m "feat: cooldown admission check for searchArtistsByGenre"
```

---

## Task 6: Wire up `catalog.ts` (interactive call sites)

**Files:**
- Modify: `src/routes/catalog.ts:51`, `:159`, and `:318`
- Test: `test/routes/catalog.test.ts`

**Interfaces:**
- Consumes: `fetchArtistTracks(token, artistId, limit, priority, kv)` (Task 3), `fetchArtistTracksQuick(token, artistId, kv)` (Task 4), `fetchTrackById(token, trackId, kv)` (Task 2).
- **Important:** `catalog.ts:159` (`fetchArtistTracksQuick(token, artistRow.spotify_id)`, inside the quick-path branch of `GET /api/artists/:id`) is the *exact* call site the original bug report's Sentry error came from (`GET /v1/albums/{id}/tracks?limit=5`). If this call site doesn't pass `kv`, a real production 429 there would never mark the cooldown flag at all -- silently defeating the whole point of this plan. Do not skip it.

- [ ] **Step 1: Write the failing tests**

In `test/routes/catalog.test.ts`, update the top-level `beforeEach` (lines 13-31) to also clear the cooldown key, so tests that set it don't leak into later ones:

```ts
beforeEach(async () => {
  // Children before parents: tracks/artists reference users via added_by_user_id,
  // and tracks references artists — deleting users/artists first trips the FK constraint
  // once a prior test has left a row with a non-null reference.
  await env.DB.exec(
    'DELETE FROM genres; DELETE FROM music_swipes; DELETE FROM sessions; DELETE FROM tracks; DELETE FROM artists; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;'
  );
  // fetchArtistTracksCached (src/routes/catalog.ts) caches GET /api/artists/:id's
  // track fetch in RATE_LIMIT_KV, keyed by spotify_id+limit -- since most tests
  // below reuse the same seeded 'local-1' artist, a stale cached result from an
  // earlier test would otherwise leak into a later one asserting a different
  // track list for that same artist/limit pair.
  const cachedKeys = await env.RATE_LIMIT_KV.list({ prefix: 'artist-tracks-cache:' });
  await Promise.all(cachedKeys.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
  await env.RATE_LIMIT_KV.delete('spotify-cooldown');
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', createdAt: 1000, updatedAt: 1000 });
  await env.DB.prepare(
    `INSERT INTO artists (id, spotify_id, name, genres, source, approved, created_at) VALUES ('local-1', 'spotify-local-1', 'Local Artist', '{"pop":true}', 'seed', 1, 1000)`
  ).run();
});
```

(only change: added `await env.RATE_LIMIT_KV.delete('spotify-cooldown');`)

Add these two tests inside the `describe('quick path on a first (no ?limit=) view of an uncached artist', ...)` block, after the last existing `it(...)`:

```ts
    it('is unaffected by an active app-wide Spotify cooldown flag -- interactive priority is exempt from the background admission check', async () => {
      const albumsCallCount = stubTrackSearchCounting(makeTracks(5));
      await env.RATE_LIMIT_KV.put('spotify-cooldown', String(Date.now() + 10000));
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });

      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();

      expect(res.status).toBe(200);
      expect(body.tracks.length).toBeGreaterThan(0);
      expect(albumsCallCount()).toBeGreaterThan(0); // it actually called Spotify, not skipped
      vi.unstubAllGlobals();
    });

    it('the ?limit= "Load more" path (fetchArtistTracksCached) is also unaffected by an active cooldown flag', async () => {
      stubTrackSearch({ tracks: makeTracks(10) });
      await env.RATE_LIMIT_KV.put('spotify-cooldown', String(Date.now() + 10000));
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1?limit=10', { headers: { Cookie: cookie } });

      const res = await worker.fetch(req, env, {} as ExecutionContext);
      const body = await res.json<any>();

      expect(res.status).toBe(200);
      expect(body.tracks.length).toBeGreaterThan(0);
      vi.unstubAllGlobals();
    });

    it('marks the app-wide cooldown flag when the quick path itself hits a 429 -- the exact call site (GET /v1/albums/{id}/tracks?limit=5) the original production Sentry error came from', async () => {
      let albumTracksCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo) => {
          const url = input.toString();
          if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
          if (url.includes('/artists/') && url.includes('/albums')) {
            return new Response(JSON.stringify({ items: [{ id: 'album-1' }] }), { status: 200 });
          }
          if (url.includes('/albums/album-1/tracks')) {
            albumTracksCalls += 1;
            if (albumTracksCalls === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
            return new Response(JSON.stringify({ items: [{ id: 'trk0' }] }), { status: 200 });
          }
          if (url.includes('/v1/tracks/')) {
            const id = url.match(/\/v1\/tracks\/([^/?]+)$/)![1];
            return new Response(
              JSON.stringify({ id, name: 'Track', artists: [{ id: 'spotify-local-1', name: 'Local Artist' }], album: { images: [] }, preview_url: null }),
              { status: 200 }
            );
          }
          throw new Error(`unexpected ${url}`);
        })
      );
      const cookie = await cookieFor('u1');
      const req = new Request('http://localhost/api/artists/local-1', { headers: { Cookie: cookie } });

      const res = await worker.fetch(req, env, {} as ExecutionContext);

      expect(res.status).toBe(200); // spotifyFetch's own retry succeeds -- the user never sees this
      expect(await env.RATE_LIMIT_KV.get('spotify-cooldown')).not.toBeNull();
      vi.unstubAllGlobals();
    }, 5000);
```

**Note:** `stubTrackSearch` is defined at the top of the outer `describe('GET /api/artists/:id', ...)` block (around line 116) and is already in scope for nested blocks; `stubTrackSearchCounting` and `makeTracks` are defined at the top of the `quick path...` block itself (around lines 442 and 455).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/catalog.test.ts`
Expected: FAIL — `fetchArtistTracksCached` and the `POST /api/tracks` route don't pass `kv` yet, so nothing about these tests actually depends on cooldown state, but more importantly `catalog.ts` doesn't compile against `fetchArtistTracks`'s new required-with-background-only signature until Tasks 3-5 land (which they will have, by this point in the plan) — these specific new tests should still currently pass even before Task 6's own changes, since interactive was always the default. Confirm they pass with the OLD code too (as a sanity check they're testing real behavior, not a tautology) is optional; the meaningful regression bar is Step 4 below.

- [ ] **Step 3: Write the implementation**

In `src/routes/catalog.ts`, update the `fetchArtistTracksCached` function (line 51):

```ts
async function fetchArtistTracksCached(env: Env, token: string, spotifyArtistId: string, limit: number) {
  const cached = await readArtistTracksCache(env.RATE_LIMIT_KV, spotifyArtistId, limit);
  if (cached) return cached;

  const tracks = await fetchArtistTracks(token, spotifyArtistId, limit, 'interactive', env.RATE_LIMIT_KV);
  await writeArtistTracksCache(env.RATE_LIMIT_KV, spotifyArtistId, limit, tracks);
  return tracks;
}
```

(only change: the `fetchArtistTracks` call now passes `'interactive'` and `env.RATE_LIMIT_KV`)

Update the quick-path branch inside `GET /api/artists/:id` (line 159):

```ts
          topTracks = await fetchArtistTracksQuick(token, artistRow.spotify_id, env.RATE_LIMIT_KV);
```

(was: `topTracks = await fetchArtistTracksQuick(token, artistRow.spotify_id);` -- this is the actual production call site the original bug report came from; see the "Important" note above)

Update the `POST /api/tracks` route (around line 318):

```ts
    const track = await fetchTrackById(token, spotifyTrackId, env.RATE_LIMIT_KV);
```

(was: `const track = await fetchTrackById(token, spotifyTrackId);`)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/catalog.test.ts`
Expected: PASS (all existing + 3 new tests)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/routes/catalog.ts test/routes/catalog.test.ts
git commit -m "feat: wire interactive priority through catalog.ts's Spotify calls"
```

---

## Task 7: Wire up `artistTrackBackfill.ts` (background priority + cooldown-aware retry delay)

**Files:**
- Modify: `src/lib/artistTrackBackfill.ts`
- Test: `test/lib/artistTrackBackfill.test.ts`

**Interfaces:**
- Consumes: `fetchArtistTracks(token, artistId, limit, priority, kv)` (Task 3), `SpotifyCooldownActiveError` (Task 2).

- [ ] **Step 1: Write the failing tests**

In `test/lib/artistTrackBackfill.test.ts`, update the top-level `beforeEach` (lines 15-17) to also clear the cooldown key:

```ts
beforeEach(async () => {
  await env.DB.exec('DELETE FROM tracks; DELETE FROM genres; DELETE FROM artists;');
  await env.RATE_LIMIT_KV.delete('spotify-cooldown');
});
```

Update the `fakeBatch` helper (lines 53-69) to capture retry options too:

```ts
function fakeBatch(messages: ArtistTrackBackfillMessage[]) {
  const acked: ArtistTrackBackfillMessage[] = [];
  const retried: ArtistTrackBackfillMessage[] = [];
  const retryOptions: Array<{ delaySeconds?: number } | undefined> = [];
  const batchMessages = messages.map((body, i) => ({
    id: `m${i}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: () => acked.push(body),
    retry: (options?: { delaySeconds?: number }) => {
      retried.push(body);
      retryOptions.push(options);
    },
  }));
  return {
    batch: { messages: batchMessages, queue: 'artist-track-backfill', metadata: {} as any, retryAll: () => {}, ackAll: () => {} },
    acked,
    retried,
    retryOptions,
  };
}
```

(only change from the existing helper: `retry` now accepts and records `options`, and the returned object includes `retryOptions`)

Add these tests inside the `describe('processArtistTrackBackfillBatch', ...)` block, after the last existing `it(...)`:

```ts
  it('retries with a delay matching the remaining cooldown, and makes no Spotify call, when an active cooldown is in effect', async () => {
    await insertArtist('a1', 'sp1');
    const fetchSpy = vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);
    await env.RATE_LIMIT_KV.put('spotify-cooldown', String(Date.now() + 10000));
    const { batch, acked, retried, retryOptions } = fakeBatch([{ artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 }]);

    await processArtistTrackBackfillBatch(batch as any, env as any);

    expect(acked).toHaveLength(0);
    expect(retried).toHaveLength(1);
    expect(retryOptions[0]?.delaySeconds).toBeGreaterThan(0);
    expect(retryOptions[0]?.delaySeconds).toBeLessThanOrEqual(10);
    // Only the client-credentials token call happened -- no artist-albums
    // fetch at all, since the cooldown check short-circuits before it.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('still processes normally when there is no active cooldown', async () => {
    await insertArtist('a1', 'sp1');
    stubSpotify([{ id: 't1', name: 'Track One' }]);
    const { batch, acked } = fakeBatch([{ artistId: 'a1', spotifyArtistId: 'sp1', limit: 30 }]);

    await processArtistTrackBackfillBatch(batch as any, env as any);

    expect(acked).toHaveLength(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/artistTrackBackfill.test.ts`
Expected: FAIL — `processArtistTrackBackfillBatch` doesn't check for cooldown yet, so the first new test's `fetchSpy` gets more than 1 call (it actually tries the albums fetch) and `retried` ends up empty (the artist-albums fetch throws a *different* error path, or succeeds against an unstubbed URL and throws "unexpected ...", which still retries but with no `delaySeconds`).

- [ ] **Step 3: Write the implementation**

In `src/lib/artistTrackBackfill.ts`, update the import (line 1):

```ts
import { fetchArtistTracks, getClientCredentialsToken, SpotifyCooldownActiveError } from './spotify';
```

(was: `import { fetchArtistTracks, getClientCredentialsToken } from './spotify';`)

Replace the `processArtistTrackBackfillBatch` function (lines 62-97) with:

```ts
export async function processArtistTrackBackfillBatch(batch: MessageBatch<ArtistTrackBackfillMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const artistRow = await env.DB.prepare('SELECT id, genres FROM artists WHERE id = ?')
        .bind(message.body.artistId)
        .first<{ id: string; genres: string }>();
      if (!artistRow) {
        // Artist was removed (or the message is stale/malformed) -- nothing
        // to backfill.
        message.ack();
        continue;
      }

      const token = await getClientCredentialsToken(env);
      const tracks = await fetchArtistTracks(token, message.body.spotifyArtistId, message.body.limit, 'background', env.RATE_LIMIT_KV);

      const artistGenres = genresFromRow(artistRow.genres);
      const now = Date.now();
      for (const track of tracks) {
        const result = await upsertTrack(env.DB, track, artistRow.id, 'spotify_search', null, now);
        if (result.inserted) await recordCatalogGenres(env.DB, artistGenres, 'track', now);
      }

      await writeArtistTracksCache(env.RATE_LIMIT_KV, message.body.spotifyArtistId, message.body.limit, tracks);
      message.ack();
    } catch (err) {
      if (err instanceof SpotifyCooldownActiveError) {
        // A cooldown-skip means we never even attempted a Spotify call for
        // this artist -- retry once the cooldown itself has cleared instead
        // of hot-looping straight back into it (the default immediate
        // retry every other error still gets, below).
        message.retry({ delaySeconds: Math.max(1, Math.ceil(err.remainingMs / 1000)) });
      } else {
        console.error('Artist track backfill failed', err);
        // No dead-letter queue configured -- a message that exhausts its
        // retries (wrangler.toml: max_retries = 3) is simply dropped. Same
        // reasoning as genreEnrichment.ts's queue consumer: the next viewer's
        // cache-miss quick-path request will attempt a fresh enqueue once the
        // pending-lock TTL clears, so this artist isn't permanently stuck.
        message.retry();
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/artistTrackBackfill.test.ts`
Expected: PASS (all existing + 2 new tests)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/lib/artistTrackBackfill.ts test/lib/artistTrackBackfill.test.ts
git commit -m "feat: wire background priority + cooldown-aware retry into the backfill queue consumer"
```

---

## Task 8: Wire up `artistTopUp.ts` (background priority + graceful per-artist degradation)

**Files:**
- Modify: `src/lib/artistTopUp.ts`
- Test: `test/lib/artistTopUp.test.ts`

**Interfaces:**
- Consumes: `fetchArtistTracks(token, artistId, limit, priority, kv)` (Task 3). `searchArtistsByGenre`'s call site here was already updated in Task 5.

- [ ] **Step 1: Write the failing tests**

In `test/lib/artistTopUp.test.ts`, update the top-level `beforeEach` (lines 12-15) to also clear the cooldown key:

```ts
beforeEach(async () => {
  await env.DB.exec('DELETE FROM genres; DELETE FROM tracks; DELETE FROM artists; DELETE FROM user_genres; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
  await env.RATE_LIMIT_KV.delete('spotify-cooldown');
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1', createdAt: 1000, updatedAt: 1000 });
});
```

Add this test inside the `describe('topUpArtistsForUser', ...)` block, after the last existing `it(...)`:

```ts
  it("skips an artist's track fetch (but keeps the artist itself, and continues) when cooldown becomes active between the search and the track fetch", async () => {
    await env.DB.prepare(
      `INSERT INTO user_genres (id, user_id, genre, artist_count, track_count, created_at, updated_at) VALUES ('ug1', 'u1', 'indie', 5, 2, 1000, 1000)`
    ).run();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
        if (url.includes('type=artist')) {
          // Simulates a cooldown becoming active right after the search
          // succeeds but before this artist's track fetch runs -- setting
          // cooldown up front instead would also block the search itself
          // (searchArtistsByGenre checks the same flag), which isn't the
          // scenario this test is isolating.
          await env.RATE_LIMIT_KV.put('spotify-cooldown', String(Date.now() + 10000));
          return new Response(
            JSON.stringify({
              artists: {
                items: [{ id: 'a1', name: 'Indie Artist One', genres: ['indie'], images: [{ url: 'https://img/a1.jpg' }], popularity: 50 }],
              },
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected ${url}`);
      })
    );

    const inserted = await topUpArtistsForUser(env as any, await loadUser());

    // The artist row itself is created before the track fetch runs, so it's
    // still inserted -- only the (skipped) track fetch is affected.
    expect(inserted).toBe(1);
    const row = await env.DB.prepare('SELECT * FROM artists WHERE spotify_id = ?').bind('a1').first<any>();
    expect(row).toBeTruthy();
    const trackRows = await env.DB.prepare('SELECT * FROM tracks WHERE artist_id = ?').bind(row.id).all<any>();
    expect(trackRows.results).toHaveLength(0);
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/artistTopUp.test.ts`
Expected: FAIL — `fetchArtistTracks`'s call in `artistTopUp.ts` isn't wrapped in try/catch yet, so the thrown `SpotifyCooldownActiveError` propagates up out of `topUpArtistsForUser` entirely (rejecting the whole call, not returning `1`).

- [ ] **Step 3: Write the implementation**

In `src/lib/artistTopUp.ts`, replace the track-fetch section inside the artist loop (currently lines 73-77) with:

```ts
      let tracks: any[];
      try {
        tracks = await fetchArtistTracks(token, artist.id, TRACKS_PER_ARTIST, 'background', env.RATE_LIMIT_KV);
      } catch (error) {
        console.error(`topUpArtistsForUser: track fetch failed for artist "${artist.id}":`, error);
        continue;
      }
      for (const track of tracks) {
        const trackResult = await upsertTrack(env.DB, track, artistResult.id, 'spotify_search', null, now);
        if (trackResult.inserted) await recordCatalogGenres(env.DB, artist.genres ?? [], 'track', now);
      }
```

(was:
```ts
      const tracks = await fetchArtistTracks(token, artist.id, TRACKS_PER_ARTIST);
      for (const track of tracks) {
        const trackResult = await upsertTrack(env.DB, track, artistResult.id, 'spotify_search', null, now);
        if (trackResult.inserted) await recordCatalogGenres(env.DB, artist.genres ?? [], 'track', now);
      }
```
)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/artistTopUp.test.ts`
Expected: PASS (all existing + 1 new test)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (845 + all newly added tests across all 8 tasks, 0 failures).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/artistTopUp.ts test/lib/artistTopUp.test.ts
git commit -m "feat: wire background priority + graceful degradation into deck top-up"
```

---

## Final verification (after all 8 tasks)

- [ ] Run `npm test` — full suite green.
- [ ] Run `npx tsc --noEmit` — no type errors.
- [ ] Confirm `git log --oneline` shows 8 feature commits on top of the two spec-doc commits already on this branch.
- [ ] Re-read `docs/superpowers/specs/2026-08-12-spotify-call-throttle-design.md`'s "Testing" section against the actual test files touched, to confirm every listed item has a corresponding test.
