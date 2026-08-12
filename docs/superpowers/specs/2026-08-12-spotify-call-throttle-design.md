# Spotify call throttling for background artist-track work

## Problem

`GET /api/artists/:id` (the artist page) has been intermittently failing with
`SpotifyRateLimitError: Spotify rate-limited this request even after 3
retries: https://api.spotify.com/v1/albums/{id}/tracks?limit=5` in
production Sentry reports. That specific URL shape (`limit=5`) identifies
the failing call as `fetchArtistTracksQuick`'s own album-tracks fetch — the
lightweight "quick path" introduced by PR #70 (`ae1e0f7`) to keep first
views of a brand-new artist fast. On its own, ~7 Spotify calls should not be
enough to trip a real rate limit.

Root cause: Spotify enforces its own rate limit **app-wide**, independent of
this app's own per-IP limiter (`src/index.ts`) and independent of any single
request. Every quick-path cache miss also enqueues a background "backfill"
job (`src/lib/artistTrackBackfill.ts`) that runs the full ~41-call
`fetchArtistTracks` fan-out off the request path. Cloudflare Queues can
start processing that job within moments of being enqueued (`max_batch_timeout
= 30`, but often sooner). The deck's candidate top-up
(`src/lib/artistTopUp.ts`, `topUpArtistsForUser`) does something similar —
up to ~50 Spotify calls — whenever a user's artist candidate pool runs low.

PR #70 fixed the *symptom* (a slow/blocking synchronous fetch on the request
path) by moving the large fan-out to the background. It did not reduce total
Spotify call volume, nor did it add any coordination between the request
path and background jobs sharing the same app-wide budget. The result: a
background job's burst for one artist can — and, per Sentry, does — collide
with an unrelated, much smaller quick-path request for a different artist
opened moments later, tripping the shared limit on the smaller request. The
classic trigger is a search → select a new artist flow, since that
guarantees a fresh backfill gets queued; but the symptom shows up on
whichever request happens to be in flight when the shared budget is
exhausted, which is why it "happens whenever the page is loaded," not just
right after a search.

Spotify's actual limit (request count, window size) is not documented or
known to us — it must be treated as a black box discovered only through live
429 responses.

## Goals

- Meaningfully reduce how often background work (backfill queue, deck
  top-up) causes an interactive page load (artist page, search, add-artist)
  to hit Spotify's rate limit.
- Do not add any new latency or failure mode to interactive requests beyond
  what exists today (their own 429-retry-with-backoff, unchanged).
- Do not require knowing Spotify's actual limit — react to real 429 signals
  rather than a guessed quota.
- Reuse this codebase's existing KV-based rate-limiting pattern
  (`src/lib/rateLimit.ts`) rather than introducing new infrastructure (e.g.
  Durable Objects) this project doesn't otherwise use.
- Keep KV read/write volume low — checks happen per logical unit of
  background work, not per individual Spotify HTTP call.

## Non-goals

- Do not reduce the *depth* of a single backfill pass (`ARTIST_PROFILE_TRACK_LIMIT`
  stays 30). If Sentry still shows collisions after this ships, revisit
  fetching in smaller re-enqueued stages as a follow-up.
- Do not pursue Spotify Extended Quota Mode (separate, already-tracked
  effort in `docs/spotify-extended-quota.md`) or batch-endpoint access —
  both out of our control and out of scope here.
- Do not change anything about the interactive request path's own behavior
  or response shape.

## Design

### 1. Reactive cooldown flag (`src/lib/spotifyThrottle.ts`, new file)

A single global KV key (`spotify-cooldown`, in the existing `RATE_LIMIT_KV`
namespace) records whether Spotify has recently 429'd anything, anywhere in
the app. Its value is the absolute epoch-ms expiry (not just a flag), so
callers can read back how much cooldown remains.

```ts
export async function markSpotifyCooldown(
  kv: KVNamespace,
  retryAfterSeconds?: number
): Promise<void>;
// Writes `spotify-cooldown` = String(Date.now() + ttlMs), where ttlMs is
// derived from retryAfterSeconds when it's a valid positive number, else
// SPOTIFY_COOLDOWN_DEFAULT_SECONDS = 15 (a conservative starting guess --
// roughly half of the ~30s window implied by the Sentry reports -- tune
// from observed production data as it comes in).
//
// Cloudflare KV requires expirationTtl >= 60s, which is longer than the
// intended cooldown duration (15s default, and most real Retry-After
// values). The KV write's own expirationTtl is floored to 60s purely so
// the row eventually self-cleans -- it is NOT the signal isSpotifyCoolingDown
// uses. That function compares the stored expiry timestamp (the real,
// possibly-shorter duration) against Date.now(), so cooldown correctly
// clears after the intended 15s even though the underlying KV row persists
// up to 60s.

export async function isSpotifyCoolingDown(
  kv: KVNamespace
): Promise<number | null>;
// Returns remaining ms until cooldown clears, or null if there is no
// active cooldown (key absent or its stored expiry has already passed).
```

`markSpotifyCooldown` is called from `spotifyFetch` (`src/lib/spotify.ts`)
the moment it sees the *first* 429 for a given call, before its existing
retry loop proceeds — for calls of either priority. This is the earliest,
most actionable signal that Spotify is currently constrained.

### 2. Priority-aware admission (checked once per background job, not per HTTP call)

`spotifyFetch` gains an optional `kv?: KVNamespace` parameter, used only to
**write** the cooldown flag when it sees a 429 — it makes no admission
decision itself and carries no concept of priority.

The admission **check** lives one level up, in `fetchArtistTracks` and
`searchArtistsByGenre` (the only two functions ever invoked with
`'background'` priority) — once at the very top of each call, before any
Spotify request is made:

- `'background'`: checks `isSpotifyCoolingDown` first. If cooldown is
  active, throws `SpotifyCooldownActiveError` immediately — **no HTTP
  request is made at all**. No Spotify budget is wasted piling onto
  whatever is already causing pressure.
- `'interactive'` (the default for callers that never pass a priority):
  skips the check entirely and always attempts the call, protected only by
  `spotifyFetch`'s existing 429-retry-with-backoff loop (unchanged). A real
  user waiting on a response is never preemptively blocked by our own
  internal guess.

Checking once per **logical unit of background work**, rather than inside
`spotifyFetch` itself, keeps KV read volume low — see "KV volume" below. A
fan-out that's already mid-flight when cooldown appears is allowed to
finish; the goal is stopping background jobs from *starting* fresh bursts
during a hot window, not micromanaging one already running.

### 3. Priority threading

Only functions genuinely shared between interactive and background contexts
need `priority` threaded from the caller:

**Threaded:**
- `fetchArtistTracks(token, artistId, limit, priority)` — called from
  `catalog.ts`'s `?limit=` "Load more" reload (`'interactive'`),
  `artistTrackBackfill.ts`'s queue consumer (`'background'`), and
  `artistTopUp.ts` (`'background'`). Forwards `priority` to its own
  sub-calls (`fetchArtistAlbumIds`, `fetchAlbumTrackIds`,
  `fetchTracksByIds`) and ultimately to `spotifyFetch`.

**Hardcoded internally** (single-context call sites — no threading needed):
- `fetchArtistTracksQuick` → always `'interactive'`
- `fetchArtistById`, `searchArtistsByName`, `searchTracksByArtist`,
  `fetchTrackById` → always `'interactive'`
- `searchArtistsByGenre` → always `'background'`

**Untouched:** `getClientCredentialsToken` / token refresh calls hit
`accounts.spotify.com`, a separate rate-limit surface from
`api.spotify.com` — out of scope.

**Call sites to update:**
- `catalog.ts`: `fetchArtistTracksCached` passes `'interactive'`.
- `artistTrackBackfill.ts`: `processArtistTrackBackfillBatch` passes
  `'background'`.
- `artistTopUp.ts`: passes `'background'` to `fetchArtistTracks`.

### 4. Burst-shaping for background priority (inside `fetchArtistTracks`)

Two changes, both gated on `priority === 'background'` and both inside
`fetchArtistTracks`'s existing album/track fan-out logic:

- **Early-stop on album-list gathering.** Today, `fetchArtistTracks` fetches
  all (up to 10) albums' track-ID lists unconditionally via one
  `mapWithConcurrency` call, then slices to `limit` afterward — deliberately
  avoiding sequential round trips because that used to run synchronously on
  the request path (see the existing comment in `spotify.ts`). That
  trade-off no longer applies to background callers, since nothing is
  waiting on them. For `'background'`, fetch albums' track-lists in chunks
  (reusing `ALBUM_TRACKS_FETCH_CONCURRENCY = 5`), checking the accumulated
  track-ID count after each chunk and stopping before fetching further
  albums once `limit` is satisfied. `'interactive'` keeps today's
  all-at-once behavior unchanged.
- **Inter-call pacing.** `mapWithConcurrency` gains an optional `delayMs`
  parameter — after each worker finishes one item, it waits that long
  before starting the next. Background-priority calls (both the album-list
  phase and the per-track detail phase) pass
  `SPOTIFY_BACKGROUND_PACING_DELAY_MS = 250` (a starting guess, tunable);
  interactive calls pass `0` (no behavior change). This spreads the same
  total call count over a longer wall-clock window instead of clustering it
  in the first couple of seconds, which directly targets "too many calls in
  a rolling window" rather than "too many calls total" — the one part of
  the fan-out (~30 individual track-detail calls) that's structurally fixed
  by Spotify's batch-tracks endpoint 403ing in Development Mode.

Net effect on a typical backfill job: album-list calls drop from up to 10
down to whatever's actually needed (commonly 2-4 for a full album/single
mix), and the remaining ~30-35 calls spread across roughly 10-15 seconds
instead of 2-3.

### 5. Error handling

`SpotifyCooldownActiveError extends Error` (new, distinct from the existing
`SpotifyRateLimitError`, which means "we tried and Spotify said no after
real retries" — this new one means "we didn't even attempt the call,
because we saw a recent 429 elsewhere").

- **`processArtistTrackBackfillBatch`**: catch block distinguishes
  `SpotifyCooldownActiveError` from other errors. On a cooldown-skip, calls
  `message.retry({ delaySeconds: <remaining cooldown seconds, clamped> })`
  instead of the default immediate retry, so a queued job waits out the
  cooldown rather than hot-looping straight back into it. Any other error
  keeps today's plain `message.retry()`.
- **`artistTopUp.ts`**: the per-artist `fetchArtistTracks` call is
  currently *not* wrapped in try/catch (only `searchArtistsByGenre` is).
  Add one, mirroring the existing pattern a few lines up — a cooldown-skip
  (or any Spotify error) for one artist logs and continues to the next,
  rather than aborting the whole top-up run. Since cooldown typically
  persists for the loop's duration, remaining iterations will also
  cooldown-skip quickly (cheap KV reads only, no wasted Spotify calls), and
  the function returns whatever count it inserted before cooldown started.

Interactive paths are untouched: `SpotifyCooldownActiveError` is never
thrown there (interactive never checks cooldown), and the existing
`SpotifyRateLimitError` → 503 "Spotify's a little busy" translation in
`src/index.ts` is unchanged.

### KV volume

Checking once per logical unit of background work (not per raw HTTP call)
keeps this cheap:

- **Reads:** ~1 per backfill job (`fetchArtistTracks`'s own top-of-call
  check) instead of ~41; up to ~13 per top-up run (10 artists +
  3 genre searches) instead of ~50. Interactive calls add zero reads —
  they skip the check entirely.
- **Writes:** only on an actual 429 — the rare failure event this design
  exists to reduce — so write volume doesn't scale with request volume at
  all.

Real-world total: single-digit-to-low-double-digit KV reads per background
job run, near-zero writes. Not a scaling concern.

## Testing

Every touched module already has a matching test file — this extends
existing coverage rather than inventing new suites:

- **New `test/lib/spotifyThrottle.test.ts`:** `markSpotifyCooldown` writes
  the right TTL/expiry (including the `retryAfterSeconds` vs. default-value
  branch); `isSpotifyCoolingDown` returns `null` when unset or expired, and
  remaining-ms when active.
- **`test/lib/spotify.test.ts`:**
  - Background priority + active cooldown → throws
    `SpotifyCooldownActiveError` without ever calling `fetch` (mock
    assertion).
  - Interactive priority ignores an active cooldown and calls `fetch`
    normally.
  - A 429 response triggers `markSpotifyCooldown` (honoring `Retry-After`
    when present) before the existing retry loop proceeds, for both
    priorities.
  - Extending the existing `fetchArtistTracks` describe block: background
    priority stops fetching further albums' track-lists once `limit` is
    already satisfied by earlier ones; interactive priority still fetches
    all albums up front unchanged (regression guard against the existing
    concurrency tests at lines ~150/184).
- **`test/lib/artistTrackBackfill.test.ts`:** an active cooldown makes the
  consumer call `message.retry({ delaySeconds })` and never touch `fetch`.
- **`test/lib/artistTopUp.test.ts`:** a cooldown-skip on one artist doesn't
  abort the whole run — remaining genres/artists still get attempted (and
  also skip cheaply), function returns the partial count.
- **`test/routes/catalog.test.ts`:** quick-path response is unaffected by
  an active cooldown flag (end-to-end sanity check that interactive really
  is exempt).

## Rollout notes

No `sw.js` / `APP_SHELL` / CSP changes — this is entirely server-side
(`src/`), no static assets touched. No migration needed — uses the
existing `RATE_LIMIT_KV` namespace and existing key-per-purpose convention.

`SPOTIFY_COOLDOWN_DEFAULT_SECONDS` (15) and
`SPOTIFY_BACKGROUND_PACING_DELAY_MS` (250) are both explicit constants with
comments flagging them as starting guesses to tune from real Sentry data,
consistent with how this codebase already documents similar guessed
constants (e.g. `SPOTIFY_MAX_RETRIES`'s own comment history).
