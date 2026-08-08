# Auth Provider Tables (Phase 1 of Google Sign-On) — Design

**Status:** Approved, pending implementation plan.

## Goal

Extract Spotify-specific columns off `users` into two general-purpose tables, so a future identity provider (starting with Google, in a follow-up PR) can be added without special-casing `users`. **This is a pure refactor** — zero new user-facing behavior. Every existing user must be able to log in and use the app exactly as before once this ships.

This is Phase 1 of a two-phase plan (design discussion: adding Google Sign-On). Phase 2 (actually adding Google as a login option) is a separate spec/plan/PR, built on top of this one, once this merges.

## Current State

`users` (`migrations/0001_baseline_schema.sql`) carries six Spotify-specific columns directly: `spotify_id` (`UNIQUE NOT NULL`), `access_token`/`refresh_token`/`token_expires_at` (all `NOT NULL`), `spotify_avatar_url`, `spotify_product`. Every other table already references `users(id)` (a UUID) as its foreign key — confirmed across all of `migrations/0001_baseline_schema.sql`, never `users(spotify_id)` — so `users.id` is already the correct, sole join key everywhere except within `users` itself.

The `NOT NULL` constraints on `access_token`/`refresh_token`/`token_expires_at`/`spotify_id` are the actual blocker for a second identity provider: no user can exist without Spotify tokens today, by schema design.

## New Schema

```sql
CREATE TABLE auth_identities (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  provider     TEXT NOT NULL,        -- 'spotify' today; 'google' in Phase 2
  provider_id  TEXT NOT NULL,        -- the provider's own user id (Spotify id, Google sub, ...)
  email        TEXT,                 -- email as reported by that provider, if any
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(provider, provider_id)
);

CREATE TABLE music_source_tokens (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  provider          TEXT NOT NULL,   -- 'spotify' today; a future music-data source (e.g. Apple Music) would add a row here, not a column on users
  provider_user_id  TEXT NOT NULL,
  access_token      TEXT NOT NULL,   -- encrypted at rest, same treatment as today
  refresh_token     TEXT NOT NULL,
  token_expires_at  INTEGER NOT NULL,
  avatar_url        TEXT,            -- imported profile photo; NEVER a match-facing photo (same rule as today's spotify_avatar_url)
  product_tier      TEXT,            -- e.g. Spotify's "premium" | "free" | "open"
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(user_id, provider),
  UNIQUE(provider, provider_user_id)
);
```

`auth_identities` answers "how does this user log in" (identity-only providers like Google, in Phase 2, never get a `music_source_tokens` row at all — they don't need ongoing token storage). `music_source_tokens` answers "where do we pull this user's music-taste data from" (only Spotify today; a future Apple Music/SoundCloud source would add rows here, not new columns on `users`).

## Migration (same file, `migrations/0006_extract_auth_provider_tables.sql`)

1. `CREATE TABLE auth_identities` / `CREATE TABLE music_source_tokens` (above).
2. For every existing `users` row: insert one `auth_identities` row (`provider='spotify'`, `provider_id = users.spotify_id`, `email = users.email`) and one `music_source_tokens` row (`provider='spotify'`, `provider_user_id = users.spotify_id`, tokens/avatar/product copied across).
3. `ALTER TABLE users DROP COLUMN` for `access_token`, `refresh_token`, `token_expires_at`, `spotify_avatar_url`, `spotify_product` only.

**Platform constraint discovered during implementation, changing this section from the original plan:** `spotify_id` is **not** dropped from `users` in this migration. SQLite cannot drop a `UNIQUE` column via plain `ALTER TABLE` (confirmed empirically — `access_token` alone drops fine; `spotify_id` throws `SQLITE_ERROR: cannot drop UNIQUE column`). The standard SQLite workaround — rebuild the table under a temporary name, then rename — is itself blocked in D1: D1 enforces foreign keys unconditionally (already independently confirmed in `src/lib/accountDeletion.ts`'s module comment re: `PRAGMA foreign_keys=OFF` not being honored), and empirically, `DROP TABLE users` fails with `SQLITE_CONSTRAINT_FOREIGNKEY` — even under `PRAGMA defer_foreign_keys = ON` — because roughly 14 other tables (`sessions`, `matches`, `people_swipes`, etc.) have a live `REFERENCES users(id)` foreign key. Rebuilding every referencing table too, just to relax one column's constraint, is a disproportionate, high-risk operation for what was scoped as a low-risk refactor.

`users.spotify_id` therefore stays in place, still `UNIQUE NOT NULL`, as a legacy column the application no longer reads — `auth_identities` is the authoritative source for identity lookups going forward. Every functional code path (`getValidAccessToken`, `/callback`, the admin hard-delete lookup, account deletion's tombstone/cascade) is still rewritten against the new tables exactly as designed; only the literal removal of the `spotify_id` column is deferred. This means `auth.ts`'s new-user insert and `accountDeletion.ts`'s tombstone insert must keep supplying a `spotify_id` value (to satisfy the still-live constraint) alongside writing the real data to `auth_identities`/`music_source_tokens`. Solving `spotify_id`'s constraint for a genuinely Spotify-less (e.g. Google-only) user is deferred to the Google Sign-On follow-up itself, once it's actually needed — at that point there will be a concrete decision to make (a placeholder value, or finally justifying the full cascade rebuild across every referencing table) with fuller context than exists here.

## Code Changes

- **`src/lib/session.ts`** — `UserRow` loses the six fields. This is the single choke point every consumer (`tokens.ts`, `matching.ts`, `artistTopUp.ts`, `peopleSwipes.ts`, `me.ts`) already imports from one place, so the type change ripples correctly everywhere via `tsc`.
- **`src/lib/tokens.ts`** (`getValidAccessToken`) — **keeps its exact signature** (`user: UserRow`, still has `.id`, which is all it needs). Internally, instead of reading `user.access_token`/`refresh_token`/`token_expires_at` off the passed object, it queries `music_source_tokens` by `user.id` + `provider = 'spotify'`, and updates that row on refresh instead of `users`. **Zero changes at any of its 7 call sites** (`me.ts:18`, `catalog.ts:33,63,155,184,206`, `artistTopUp.ts:34`) — they still call `getValidAccessToken(user, env, env.DB)` exactly as today. Throws a clear error when no matching row exists (not reachable today, since every existing user has exactly one Spotify row post-migration; becomes reachable in Phase 2 for a Google-only user, at which point the existing `.catch(() => getClientCredentialsToken(env))` at every call site except `me.ts:18` already handles it — `me.ts`'s guard is explicitly Phase 2's job, out of scope here).
- **`src/routes/auth.ts`** (`/callback`) — becomes a 3-table write instead of 1. Look up `auth_identities` where `provider='spotify' AND provider_id=profile.id` to find `user_id` (replacing today's `SELECT ... FROM users WHERE spotify_id = ?`, same deliberately-unfiltered-by-`deleted_at` reactivation logic). If found: update the matching `music_source_tokens` row (tokens/avatar/product) and clear `users.deleted_at`. If not found: insert a new `users` row (unchanged shape minus the six columns) + one `auth_identities` row + one `music_source_tokens` row.
- **`src/routes/admin.ts`** (dev-only hard-delete lookup, line 33) — `SELECT id FROM users WHERE id = ? OR spotify_id = ?` becomes a join through `auth_identities`.
- **`src/lib/accountDeletion.ts`**:
  - `ensureTombstoneUser` (lines 24-33) — currently inserts a dummy `users` row with placeholder `spotify_id`/tokens solely to satisfy `reports.reported_id`'s FK. Post-migration, the tombstone user is inserted with **no** `auth_identities`/`music_source_tokens` rows at all — nothing requires a user to have one (a tombstone never logs in), so this actually gets simpler, not harder.
  - `hardDeleteUser` — add `DELETE FROM auth_identities WHERE user_id = ?` and `DELETE FROM music_source_tokens WHERE user_id = ?` alongside its existing per-table cascade deletes, before the final `DELETE FROM users WHERE id = ?`.
- **`src/routes/me.ts`** — untouched. Every existing user has exactly one Spotify `music_source_tokens` row post-migration, so `getValidAccessToken(user, env, env.DB)` at line 18 behaves identically. Making this Google-safe is explicitly Phase 2 scope.

## Test Infrastructure

21 test files currently hand-roll `INSERT INTO users (..., spotify_id, access_token, refresh_token, token_expires_at, ...)` with near-identical dummy values. Introduce one shared helper, `test/helpers/createUser.ts`, exporting an `insertTestUser(db, overrides?)` function that performs the 3-table insert (users + auth_identities + music_source_tokens) with sensible defaults (matching today's dummy-token convention), returning the new user's id. Update all 21 files to use it instead of their inline `INSERT INTO users`.

## Testing

- **Migration backfill logic cannot be tested through the normal suite** — `test/apply-schema.ts` applies every migration sequentially before any test runs, so there's no reachable "pre-0006 shape with existing data" state in the test harness to migrate; by the time any test's `INSERT` runs, the six columns are already gone. This mirrors migration `0002`'s same untestable-in-harness data rewrite. The real verification is: (a) the migration SQL is reviewed carefully against the actual production `users` row shape before deploy (mirroring how `0002`'s careful `defer_foreign_keys` comments read), and (b) the full suite passing against the *post-migration* schema proves every code path works correctly with the new tables — which is what's actually achievable and meaningful here.
- `getValidAccessToken`: covers the "row exists, valid" (unchanged), "row exists, expired, refreshes" (unchanged behavior, new storage), and "no row exists, throws" (new, unreachable by real users today, but exercised directly at the unit level) cases.
- `auth.ts` `/callback`: existing tests (login creates a user + session; repeat login reactivates a soft-deleted user; repeat login updates tokens) must all still pass unchanged in outcome, now backed by the 3-table write.
- `accountDeletion.ts`: hard-delete test confirms `auth_identities`/`music_source_tokens` rows are actually gone, not orphaned.
- Full suite (`npx vitest run`) and `npx tsc --noEmit` clean — the real gate here, since this touches so many files by nature of the refactor.

## Out of Scope

- Adding Google (or any other provider) as an actual login option — that's Phase 2, a separate spec/plan/PR built on top of this one.
- `me.ts`'s "no Spotify linked" guard — not reachable until Phase 2 introduces users who can legitimately have zero `music_source_tokens` rows.
- Any UI change. `/login` still goes straight to Spotify OAuth; nothing about the login screen changes in this phase.
