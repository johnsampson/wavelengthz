# Artist Catalog Growth — Design

**Status:** Approved, pending implementation plan.

## Problem

Users can exhaust the music/artist swipe deck (`GET /api/candidates/music`) and permanently see "No more candidates right now" — this should never happen.

## Root Cause

Two independent swipe decks exist: music/artist (`src/routes/musicSwipes.ts`) and people (`src/routes/peopleSwipes.ts`). This design covers the **artist deck only** — that's what the bug report refers to, and it's the one with an existing (broken) anti-exhaustion mechanism. The people deck has no anti-exhaustion mechanism at all today; that's a known, separate gap, explicitly out of scope here.

The artist deck already has a top-up mechanism (`src/lib/artistTopUp.ts`, `topUpArtistsForUser`), triggered from `musicSwipes.ts` synchronously when a user's remaining unswiped-artist count hits 0, and in the background (`ctx.waitUntil`) once it drops below 15. It fails to keep the pool full for two compounding reasons, both verified directly against the local dev D1 catalog:

1. **Genre personalization was never real.** Every artist in the catalog has an empty `genres` column (`{}`) — confirmed against 100% of the local catalog. Spotify's search results don't reliably include per-artist genre tags (the codebase already documents this exact behavior for a different endpoint, `src/lib/spotify.ts:88-90`). Because of this, `applyGenreAffinity` never has genres to record, `user_genres` never accumulates data for any user, and `topGenresForUser` (`artistTopUp.ts:11-23`) always falls back to the fixed 12-genre `SEED_GENRES` list. The "user's top 3 genres" selection has always silently been "the same 12 genres for everyone."
2. **The top-up search window never advances.** Each call searches one random offset in `[0, 49]` (limit 10) per genre — a shallow, non-persisted window of roughly the top 59 Spotify search results per genre. Back-to-back calls (from any user, since the catalog is shared) keep re-sampling that same window instead of paging deeper. Once the artists reachable in that window are already in the catalog, every future call finds 0 new artists and the deck goes empty — permanently, regardless of how many more artists Spotify actually has tagged with that genre. This is a shared, catalog-wide ceiling (roughly 12 genres × ~59 reachable slots, minus cross-genre and existing-catalog overlap), not a rare per-user tail case — with 82-114 artists already seeded locally, the app is likely already near it.

`src/db/seed.ts` (`seedCatalog`) already solves pagination correctly for the initial catalog build — persisted per-genre offset, round-robin across genres, advances by page size, marks a genre exhausted only on a short page or error, walks out to Spotify's real max offset (~950, i.e. Spotify's documented `offset + limit <= 1000` cap on `/v1/search`). Top-up should reuse this pattern instead of its own shallow reinvention.

## Hard Constraints

- **No artist is ever shown to the same user twice**, in either direction. Recycling left-swipes (previously considered as a fallback) is explicitly rejected — a "pass" must stay permanent. This means the fix must guarantee supply purely through genuinely new artists, forever.
- Recommendation/scoring quality (`src/lib/scoring.ts`, `src/lib/matching.ts`) is a known future area of interest but explicitly out of scope for this work — this design is about supply (never running dry), not ranking quality.

## Design

### Shared growth helper

Extract the pagination/search/insert logic that `seed.ts` already does correctly into a shared function (e.g. `src/lib/catalogGrowth.ts`), used by both the new cron job and the reactive fallback, replacing three divergent implementations with one.

```
growArtistsForGenre(env, genre, cursor) -> { inserted: number, cursor: updated }
```

Given a genre and its persisted cursor (offset + exhausted flag), searches the next page via Spotify, skips no-photo/already-cataloged artists, inserts the rest (+ up to 2 tracks each, as today), and returns the updated cursor state (advanced offset, or marked exhausted on a short page/error).

### Persisted per-genre cursor

New table (new migration, `0005_...`):

```sql
CREATE TABLE genre_search_cursors (
  genre        TEXT PRIMARY KEY,
  offset       INTEGER NOT NULL DEFAULT 0,
  exhausted    INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
```

Genre list is widened beyond the current 12 `SEED_GENRES` (more/niche genres added) to raise the total reachable ceiling, since repeats are now permanently disallowed. When every genre is exhausted, cursors cycle back to offset 0 (a full second pass may still surface previously-skipped no-photo/duplicate-adjacent results) rather than the job stalling permanently.

Genre selection is **no longer personalized** — `topGenresForUser`/`user_genres` are dropped from the top-up/growth path entirely (they carry no real signal, per Root Cause #1). Cron and the reactive fallback both round-robin the full shared genre list via the shared cursor table.

### Cron-driven growth (primary mechanism)

A new Cron Trigger becomes the primary way the catalog grows, decoupled from user request latency:

- New cron entry added to `wrangler.toml`'s existing `crons` array (alongside the 3 already there) and a new `else if (event.cron === '...')` branch in `src/index.ts`'s existing `scheduled()` handler, following the established pattern (`report('scheduled:growArtistCatalog')`).
- Runs on an interval (proposed: every 15 minutes, tunable) — a bounded batch: round-robins the genre list via the shared helper, inserting up to 50 new artists per run (tunable; mirrors the existing `SAFE_ARTISTS_PER_RUN` safety-cap precedent in `seed.ts`, scaled down since this runs unattended on a recurring schedule rather than once).
- Gated by a new enable/disable flag: `ARTIST_CATALOG_GROWTH_ENABLED` in `wrangler.toml`'s `[vars]` block (same pattern as `MATCH_NOTIFICATION_DELAY_MINUTES`). Checked at the top of the job; `"false"` makes it a no-op (the cron still fires on schedule but skips work). Unset or any other value = enabled. Flippable via `wrangler secret put` or the Cloudflare dashboard without a code deploy.

### Reactive fallback (safety net only)

`musicSwipes.ts`'s existing `remaining === 0` synchronous top-up stays, but simplified to call the same shared helper (1-2 genres, bounded to keep request latency reasonable) instead of its own random-offset logic. It should almost never fire once cron is running — kept only as insurance against a sudden swipe surge or a cron gap.

The `remaining < 15` background (`ctx.waitUntil`) top-up path is **removed entirely** — cron now owns that job.

### Tracking (source of truth)

New table, written by every cron run (success or failure):

```sql
CREATE TABLE catalog_growth_runs (
  id             TEXT PRIMARY KEY,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  genres_tried   TEXT,     -- JSON array
  inserted_count INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     INTEGER NOT NULL
);
```

This is the source of truth for the daily digest (below) and for manual inspection (`wrangler d1 execute`) — it doesn't depend on Cloudflare's log retention.

`[observability] enabled = true` is added to `wrangler.toml` (currently absent) to turn on persisted, queryable Workers Logs in the Cloudflare dashboard. `console.log`/`console.error` breadcrumbs are added to the growth job as a live-debugging aid layered on top of the D1 tracking table, not a replacement for it.

### Notifications

Reuses existing infra — Resend (`src/lib/email.ts`, already used for match emails) and Sentry (`src/lib/sentry.ts`'s `reportError`, already wired into every scheduled job's catch handler).

- **Failure:** immediate email, in addition to the existing Sentry report (Sentry isn't necessarily checked daily; email is more likely to be seen).
- **Success:** not emailed per-run (every-15-minutes would be 50-100+ emails/day) — logged to `catalog_growth_runs` instead. A new daily-digest cron entry (once/day) queries the last 24h of rows and sends one summary email (total inserted, genres exhausted, any failures).
- New secret `OPS_ALERT_EMAIL` (via `wrangler secret put`, not committed to `wrangler.toml`, same treatment as `SITE_BASIC_AUTH_*`) — the recipient for both the failure alert and the daily digest.

## Data Flow

1. Cron fires on schedule (e.g. every 15 min) → checks `ARTIST_CATALOG_GROWTH_ENABLED` → if enabled, round-robins the genre list using `genre_search_cursors`, inserting new artists/tracks into the existing shared `artists`/`tracks` tables via the shared helper → writes one row to `catalog_growth_runs` → on failure, sends an immediate email + existing Sentry report.
2. Once daily, a digest cron queries `catalog_growth_runs` for the past 24h and emails a summary to `OPS_ALERT_EMAIL`.
3. `GET /api/candidates/music`'s query and client behavior are unchanged — this is purely a supply-side fix. Its `remaining === 0` fallback now calls the shared helper directly instead of its own logic, as a rare last resort.

## Error Handling

- Per-genre Spotify failures: caught, cursor left unchanged (retry same offset next run) — distinct from a genuinely short/empty page, which marks the genre exhausted. Mirrors `seed.ts`'s existing `genreSearchErrors` distinction.
- Whole-job failures: caught by the existing `report()` wrapper in `scheduled()`, reported to Sentry, and additionally emailed per the Notifications section above.
- Reactive fallback: unchanged guarantee — a Spotify failure there must never turn an otherwise-successful (if empty) candidates request into a 500.

## Testing

- Unit tests for the shared growth helper: advances a genre's cursor correctly, detects exhaustion (short page / error), cycles all-exhausted cursors back to 0.
- Test for the new scheduled branch: respects `ARTIST_CATALOG_GROWTH_ENABLED`, writes a `catalog_growth_runs` row, per-run cap.
- Test for the daily digest job: aggregates the correct 24h window, sends via the existing email path.
- Update `test/routes/musicSwipes.test.ts` / `test/lib/artistTopUp.test.ts` for the simplified reactive fallback; remove the now-dead `< 15` background-top-up test.

## Out of Scope

- People-matching deck (`peopleSwipes.ts`) has no anti-exhaustion mechanism at all today — not addressed here.
- Recommendation/scoring algorithm quality (`scoring.ts`, `matching.ts`) — explicitly deferred.
- Recycling previously-swiped artists — explicitly rejected as a fallback strategy.
