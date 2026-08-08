# Auth Provider Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Spotify-specific columns off `users` into two general-purpose tables (`auth_identities`, `music_source_tokens`) so a second identity provider can be added later without special-casing `users` — a pure refactor with zero user-facing behavior change.

**Architecture:** `users.id` (already the UUID every other table joins on) stays the sole cross-table key. A new `auth_identities` table answers "how does this user log in" (one row per linked provider); a new `music_source_tokens` table answers "where do we pull this user's music-taste data from" (currently Spotify only). `getValidAccessToken` and `/callback` are rewritten against the new tables; every other call site is either unaffected or needs no signature change.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Vitest + `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Zero new user-facing behavior. Every existing user must log in and use the app exactly as before this ships. `/login` still goes straight to Spotify OAuth — no UI change in this phase (spec: `docs/superpowers/specs/2026-08-08-auth-provider-tables-design.md`).
- `users.id` remains the only column any other table's foreign key references — this plan does not change that.
- New tables, exact shape:
  ```sql
  CREATE TABLE auth_identities (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL, provider_id TEXT NOT NULL, email TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(provider, provider_id)
  );
  CREATE TABLE music_source_tokens (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL, provider_user_id TEXT NOT NULL,
    access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, token_expires_at INTEGER NOT NULL,
    avatar_url TEXT, product_tier TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(user_id, provider), UNIQUE(provider, provider_user_id)
  );
  ```
- `getValidAccessToken(user: UserRow, env: Env, db: D1Database)` keeps its exact signature — no call site (`me.ts:18`, `catalog.ts:33,63,155,184,206`, `artistTopUp.ts:34`) changes its call syntax.
- Migration backfill logic cannot be verified through the test suite (`test/apply-schema.ts` applies every migration before any test runs, so there's never a reachable pre-migration-shape state with data in the harness) — the gate here is the full suite passing against the *post*-migration schema, not a dedicated backfill test.
- Full suite (`npx vitest run`) and `npx tsc --noEmit` clean is the acceptance bar for every task from Task 2 onward, since nearly every file in the codebase touches `UserRow` transitively.

---

### Task 1: Migration + shared test-user helper

**Files:**
- Create: `migrations/0006_extract_auth_provider_tables.sql`
- Create: `test/helpers/createUser.ts`
- Create: `test/helpers/createUser.test.ts`

**Interfaces:**
- Produces: tables `auth_identities`, `music_source_tokens` (exact shape in Global Constraints).
- Produces: `insertTestUser(db: D1Database, overrides?: TestUserOverrides): Promise<string>` from `test/helpers/createUser.ts` — inserts a `users` row plus one matching `auth_identities` row (`provider='spotify'`) and one `music_source_tokens` row (`provider='spotify'`), returns the new user's id. All later tasks' test files use this instead of hand-rolled `INSERT INTO users`.
- `TestUserOverrides` fields: `id, spotifyId, email, displayName, lat, lng, maxDistanceKm, ageMin, ageMax, gender, seeking, dateOfBirth, ageVerifiedAt, onboardedAt, deletedAt, createdAt, updatedAt, accessToken, refreshToken, tokenExpiresAt, avatarUrl, productTier` — all optional.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0006_extract_auth_provider_tables.sql
-- Migration number: 0006 	 2026-08-08T18:00:00.000Z

-- Extracts Spotify token/profile storage off `users` into two general-
-- purpose tables, so a second identity provider (Google, in a follow-up)
-- can be added without special-casing `users`. `users.id` remains the only
-- column any other table's foreign key references -- confirmed unchanged
-- by this migration.
--
-- auth_identities answers "how does this user log in" -- an identity-only
-- provider (e.g. Google) never gets a music_source_tokens row at all.
-- music_source_tokens answers "where do we pull this user's music-taste
-- data from" -- only Spotify today; a future Apple Music/SoundCloud source
-- would add rows here, not new columns on users.
--
-- NOTE on spotify_id: it is NOT dropped from `users` here, unlike the
-- other five columns. SQLite cannot drop a UNIQUE column via ALTER TABLE
-- (confirmed empirically -- "cannot drop UNIQUE column" SQLITE_ERROR), and
-- the standard SQLite workaround (rebuild the table under a temp name) is
-- itself blocked in D1: D1 enforces foreign keys unconditionally (already
-- independently confirmed in src/lib/accountDeletion.ts's module comment),
-- and empirically DROP TABLE users fails with SQLITE_CONSTRAINT_FOREIGNKEY
-- -- even under PRAGMA defer_foreign_keys = ON -- because ~14 other tables
-- (sessions, matches, people_swipes, ...) hold a live REFERENCES users(id)
-- foreign key. Rebuilding every referencing table too, just to relax one
-- column, is disproportionate here. spotify_id stays in place, still
-- UNIQUE NOT NULL, as a legacy column the application no longer reads --
-- auth_identities is authoritative going forward. auth.ts's new-user
-- insert and accountDeletion.ts's tombstone insert (Tasks 3-4) must keep
-- supplying a spotify_id value to satisfy the still-live constraint.
CREATE TABLE auth_identities (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  provider     TEXT NOT NULL,
  provider_id  TEXT NOT NULL,
  email        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(provider, provider_id)
);

CREATE TABLE music_source_tokens (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  provider          TEXT NOT NULL,
  provider_user_id  TEXT NOT NULL,
  access_token      TEXT NOT NULL,
  refresh_token     TEXT NOT NULL,
  token_expires_at  INTEGER NOT NULL,
  avatar_url        TEXT,
  product_tier      TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(user_id, provider),
  UNIQUE(provider, provider_user_id)
);

-- Backfill: one auth_identities + one music_source_tokens row per existing
-- user, copying their current Spotify data across before the source
-- columns are dropped below.
INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
SELECT lower(hex(randomblob(16))), id, 'spotify', spotify_id, email, created_at, updated_at FROM users;

INSERT INTO music_source_tokens (id, user_id, provider, provider_user_id, access_token, refresh_token, token_expires_at, avatar_url, product_tier, created_at, updated_at)
SELECT lower(hex(randomblob(16))), id, 'spotify', spotify_id, access_token, refresh_token, token_expires_at, spotify_avatar_url, spotify_product, created_at, updated_at FROM users;

-- These five have no UNIQUE constraint and no other table references
-- them, so a plain DROP COLUMN works -- confirmed empirically.
ALTER TABLE users DROP COLUMN access_token;
ALTER TABLE users DROP COLUMN refresh_token;
ALTER TABLE users DROP COLUMN token_expires_at;
ALTER TABLE users DROP COLUMN spotify_avatar_url;
ALTER TABLE users DROP COLUMN spotify_product;
```

- [ ] **Step 2: Write the failing test for `insertTestUser`**

```typescript
// test/helpers/createUser.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { insertTestUser } from './createUser';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
});

describe('insertTestUser', () => {
  it('inserts a users row plus matching auth_identities and music_source_tokens rows', async () => {
    const id = await insertTestUser(env.DB, { email: 'a@example.com' });

    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<any>();
    expect(user.email).toBe('a@example.com');

    const identity = await env.DB.prepare('SELECT * FROM auth_identities WHERE user_id = ?').bind(id).first<any>();
    expect(identity.provider).toBe('spotify');
    expect(identity.provider_id).toBeTruthy();

    const token = await env.DB.prepare('SELECT * FROM music_source_tokens WHERE user_id = ?').bind(id).first<any>();
    expect(token.provider).toBe('spotify');
    expect(token.access_token).toBeTruthy();
    expect(token.token_expires_at).toBeGreaterThan(Date.now());
  });

  it('respects overrides for id, spotifyId, and profile fields', async () => {
    const id = await insertTestUser(env.DB, { id: 'fixed-id', spotifyId: 'fixed-spotify-id', lat: 30.27, lng: -97.74, gender: 'female', seeking: 'female' });

    expect(id).toBe('fixed-id');
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<any>();
    expect(user.lat).toBe(30.27);
    expect(user.gender).toBe('female');
    const identity = await env.DB.prepare('SELECT * FROM auth_identities WHERE user_id = ?').bind(id).first<any>();
    expect(identity.provider_id).toBe('fixed-spotify-id');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/helpers/createUser.test.ts`
Expected: FAIL — `test/helpers/createUser.ts` does not exist.

- [ ] **Step 4: Write `test/helpers/createUser.ts`**

```typescript
export interface TestUserOverrides {
  id?: string;
  spotifyId?: string;
  email?: string | null;
  displayName?: string | null;
  lat?: number | null;
  lng?: number | null;
  maxDistanceKm?: number;
  ageMin?: number;
  ageMax?: number;
  gender?: string | null;
  seeking?: string | null;
  dateOfBirth?: string | null;
  ageVerifiedAt?: number | null;
  onboardedAt?: number | null;
  deletedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  avatarUrl?: string | null;
  productTier?: string | null;
}

export async function insertTestUser(db: D1Database, overrides: TestUserOverrides = {}): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  const spotifyId = overrides.spotifyId ?? `spotify-${id}`;
  const now = overrides.createdAt ?? Date.now();
  const updatedAt = overrides.updatedAt ?? now;
  const tokenExpiresAt = overrides.tokenExpiresAt ?? now + 3600 * 1000;

  await db
    .prepare(
      `INSERT INTO users (
         id, spotify_id, display_name, bio, date_of_birth, age_verified_at, location_label, lat, lng,
         location_updated_at, max_distance_km, age_min, age_max, gender, seeking, intent, email,
         onboarded_at, deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      spotifyId,
      overrides.displayName ?? null,
      overrides.dateOfBirth ?? null,
      overrides.ageVerifiedAt ?? null,
      overrides.lat ?? null,
      overrides.lng ?? null,
      overrides.maxDistanceKm ?? 80,
      overrides.ageMin ?? 18,
      overrides.ageMax ?? 100,
      overrides.gender ?? null,
      overrides.seeking ?? null,
      overrides.email ?? null,
      overrides.onboardedAt ?? null,
      overrides.deletedAt ?? null,
      now,
      updatedAt
    )
    .run();

  await db
    .prepare(
      `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
       VALUES (?, ?, 'spotify', ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), id, spotifyId, overrides.email ?? null, now, updatedAt)
    .run();

  await db
    .prepare(
      `INSERT INTO music_source_tokens (id, user_id, provider, provider_user_id, access_token, refresh_token, token_expires_at, avatar_url, product_tier, created_at, updated_at)
       VALUES (?, ?, 'spotify', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      id,
      spotifyId,
      overrides.accessToken ?? 'test-access-token',
      overrides.refreshToken ?? 'test-refresh-token',
      tokenExpiresAt,
      overrides.avatarUrl ?? null,
      overrides.productTier ?? null,
      now,
      updatedAt
    )
    .run();

  return id;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/helpers/createUser.test.ts`
Expected: PASS (2/2)

- [ ] **Step 6: Commit**

```bash
git add migrations/0006_extract_auth_provider_tables.sql test/helpers/createUser.ts test/helpers/createUser.test.ts
git commit -m "feat: add auth_identities/music_source_tokens tables and test helper"
```

---

### Task 2: `UserRow` + `getValidAccessToken` rewrite

**Files:**
- Modify: `src/lib/session.ts`
- Modify: `src/lib/tokens.ts`
- Modify: `test/lib/tokens.test.ts`
- Modify: `test/lib/session.test.ts`

**Interfaces:**
- Consumes: `music_source_tokens` table (Task 1).
- Produces: `UserRow` (in `src/lib/session.ts`) without `access_token`, `refresh_token`, `token_expires_at`, `spotify_avatar_url`, `spotify_product` — `spotify_id` stays on `UserRow` (Task 1's migration note: it's a platform constraint that it can't be dropped from `users`, so `getSessionUser`'s `SELECT u.*` still returns it; the application just no longer treats it as authoritative). `getValidAccessToken(user: UserRow, env: Env, db: D1Database): Promise<string>` keeps its exact signature — internals change only.

- [ ] **Step 1: Update `UserRow` in `src/lib/session.ts`**

Remove these five lines from the `UserRow` interface: `spotify_avatar_url: string | null;`, `spotify_product: string | null;`, `access_token: string;`, `refresh_token: string;`, `token_expires_at: number;`. Leave `spotify_id: string;` in place — Task 1's migration note explains it can't be dropped from `users` (a D1/SQLite platform constraint, not an oversight); it stays on the row and the type, just no longer treated as authoritative by any application code. Nothing else in this file changes — `getSessionUser`'s `SELECT u.*` naturally returns the narrower shape once `users` itself has fewer columns (Task 1's migration already dropped the five that could be).

- [ ] **Step 2: Write the failing tests for `getValidAccessToken`**

Replace `test/lib/tokens.test.ts` entirely:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { getValidAccessToken } from '../../src/lib/tokens';
import { encrypt } from '../../src/lib/crypto';

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const env = {
  TOKEN_ENCRYPTION_KEY: KEY,
  SPOTIFY_CLIENT_ID: 'id',
  SPOTIFY_CLIENT_SECRET: 'secret',
} as any;

const user = { id: 'u1' } as any;

describe('getValidAccessToken', () => {
  it('returns the decrypted token directly when the stored token is not expired', async () => {
    const encAccess = await encrypt('valid-access-token', KEY);
    const encRefresh = await encrypt('refresh-token', KEY);
    const row = { access_token: encAccess, refresh_token: encRefresh, token_expires_at: Date.now() + 1000 * 60 * 60 };
    const first = vi.fn().mockResolvedValue(row);
    const run = vi.fn();
    const bind = vi.fn().mockReturnValue({ first, run });
    const db = { prepare: vi.fn().mockReturnValue({ bind }) } as any;

    const token = await getValidAccessToken(user, env, db);

    expect(token).toBe('valid-access-token');
    expect(run).not.toHaveBeenCalled(); // no refresh/update attempted
  });

  it('refreshes and persists new tokens into music_source_tokens when expired', async () => {
    const encAccess = await encrypt('stale-access-token', KEY);
    const encRefresh = await encrypt('refresh-token', KEY);
    const row = { access_token: encAccess, refresh_token: encRefresh, token_expires_at: Date.now() - 1000 };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access_token: 'fresh-access-token', refresh_token: 'refresh-token', expires_in: 3600 }),
          { status: 200 }
        )
      )
    );

    const first = vi.fn().mockResolvedValue(row);
    const run = vi.fn().mockResolvedValue({});
    const bind = vi.fn().mockReturnValue({ first, run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as any;

    const token = await getValidAccessToken(user, env, db);

    expect(token).toBe('fresh-access-token');
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE music_source_tokens'));

    vi.unstubAllGlobals();
  });

  it('throws a clear error when the user has no Spotify token row', async () => {
    const first = vi.fn().mockResolvedValue(null);
    const bind = vi.fn().mockReturnValue({ first });
    const db = { prepare: vi.fn().mockReturnValue({ bind }) } as any;

    await expect(getValidAccessToken(user, env, db)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/lib/tokens.test.ts`
Expected: FAIL — `getValidAccessToken` still reads `user.access_token` etc. directly, not via a DB query, so the mocked `db.prepare` is never called and `first` is never consulted.

- [ ] **Step 4: Rewrite `src/lib/tokens.ts`**

```typescript
import { decrypt, encrypt } from './crypto';
import { refreshAccessToken } from './spotify';
import type { UserRow } from './session';

interface MusicSourceTokenRow {
  access_token: string;
  refresh_token: string;
  token_expires_at: number;
}

export async function getValidAccessToken(user: UserRow, env: Env, db: D1Database): Promise<string> {
  const row = await db
    .prepare(`SELECT access_token, refresh_token, token_expires_at FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`)
    .bind(user.id)
    .first<MusicSourceTokenRow>();
  if (!row) throw new Error(`No Spotify account linked for user ${user.id}`);

  if (row.token_expires_at > Date.now()) {
    return decrypt(row.access_token, env.TOKEN_ENCRYPTION_KEY);
  }

  const refreshToken = await decrypt(row.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  const fresh = await refreshAccessToken(refreshToken, env);

  const encAccess = await encrypt(fresh.access_token, env.TOKEN_ENCRYPTION_KEY);
  const encRefresh = await encrypt(fresh.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  const expiresAt = Date.now() + fresh.expires_in * 1000;

  await db
    .prepare(`UPDATE music_source_tokens SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ? WHERE user_id = ? AND provider = 'spotify'`)
    .bind(encAccess, encRefresh, expiresAt, Date.now(), user.id)
    .run();

  return fresh.access_token;
}
```

- [ ] **Step 5: Update `test/lib/session.test.ts` to use the new helper**

Replace the `beforeEach` block's inline insert:

```typescript
beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
  await insertTestUser(env.DB, { id: 'u1' });
});
```

Add the import at the top: `import { insertTestUser } from '../helpers/createUser';`

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/lib/tokens.test.ts test/lib/session.test.ts`
Expected: PASS (3/3 and 5/5)

- [ ] **Step 7: Run the full suite and type-check**

Run: `npx vitest run`
Expected: Failures in `test/routes/auth.test.ts` and every file still hand-rolling `INSERT INTO users` with the six now-dropped columns — these are addressed by Tasks 3-7. Confirm the failures are ONLY in those known files, not somewhere unexpected.

Run: `npx tsc --noEmit`
Expected: Clean, or errors only in files this plan hasn't reached yet (Tasks 3-7) — confirm nothing outside that known set.

- [ ] **Step 8: Commit**

```bash
git add src/lib/session.ts src/lib/tokens.ts test/lib/tokens.test.ts test/lib/session.test.ts
git commit -m "refactor: move Spotify token storage from users to music_source_tokens"
```

---

### Task 3: `auth.ts` `/callback` rewrite + full `auth.test.ts` rewrite

**Files:**
- Modify: `src/routes/auth.ts`
- Modify: `test/routes/auth.test.ts`

**Interfaces:**
- Consumes: `auth_identities`, `music_source_tokens` (Task 1).
- Produces: `/callback` now performs a 3-table write (users + auth_identities + music_source_tokens) instead of one `users` upsert. External behavior (redirect targets, cookie, reactivation-on-deleted_at) is unchanged.

- [ ] **Step 1: Rewrite the `/callback` handler in `src/routes/auth.ts`**

Replace the body of `router.get('/callback', ...)` from `const token = await exchangeCodeForToken(code, env);` through the end of the `if (existing) { ... } else { ... }` block with:

```typescript
    const token = await exchangeCodeForToken(code, env);
    const profile = await fetchSpotifyProfile(token.access_token);

    const encryptedAccess = await encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY);
    const encryptedRefresh = await encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY);
    const now = Date.now();
    const expiresAt = now + token.expires_in * 1000;
    const avatarUrl = profile.images?.[0]?.url ?? null;
    const product = profile.product ?? null;

    // Deliberately not filtered by deleted_at IS NULL: (provider, provider_id) is
    // UNIQUE, so a soft-deleted row's identity permanently occupies that Spotify
    // account's slot. Signing back in during the grace period (before the nightly
    // hard-delete purge) reactivates the account below rather than leaving it
    // stuck -- found with deleted_at still set, but with no way to ever pass
    // getSessionUser's deleted_at IS NULL check, and no way to re-register the
    // same Spotify account as "new" either.
    const existingIdentity = await env.DB.prepare(
      `SELECT user_id FROM auth_identities WHERE provider = 'spotify' AND provider_id = ?`
    )
      .bind(profile.id)
      .first<{ user_id: string }>();

    let userId: string;
    let onboarded: boolean;

    if (existingIdentity) {
      userId = existingIdentity.user_id;
      const existingUser = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?')
        .bind(userId)
        .first<{ onboarded_at: number | null }>();
      onboarded = existingUser?.onboarded_at != null;

      await env.DB.prepare('UPDATE users SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(now, userId).run();
      await env.DB.prepare(
        `UPDATE music_source_tokens SET access_token = ?, refresh_token = ?, token_expires_at = ?, avatar_url = ?, product_tier = ?, updated_at = ?
         WHERE user_id = ? AND provider = 'spotify'`
      ).bind(encryptedAccess, encryptedRefresh, expiresAt, avatarUrl, product, now, userId).run();
    } else {
      userId = crypto.randomUUID();
      onboarded = false;

      // spotify_id is still a required, still-UNIQUE column on users (see
      // Task 1's migration note -- it's a platform constraint, not an
      // oversight, that it can't be dropped). Keep writing the real value
      // here for constraint satisfaction; auth_identities is what the
      // application actually reads going forward.
      await env.DB.prepare(
        `INSERT INTO users (id, spotify_id, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      ).bind(userId, profile.id, profile.email ?? null, now, now).run();
      await env.DB.prepare(
        `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
         VALUES (?, ?, 'spotify', ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), userId, profile.id, profile.email ?? null, now, now).run();
      await env.DB.prepare(
        `INSERT INTO music_source_tokens (id, user_id, provider, provider_user_id, access_token, refresh_token, token_expires_at, avatar_url, product_tier, created_at, updated_at)
         VALUES (?, ?, 'spotify', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), userId, profile.id, encryptedAccess, encryptedRefresh, expiresAt, avatarUrl, product, now, now).run();
    }
```

The `const { cookie } = await createSession(...)` line and everything after it is unchanged.

- [ ] **Step 2: Rewrite `test/routes/auth.test.ts`'s `GET /callback` describe block**

Replace the entire `describe('GET /callback', ...)` block (everything between `describe('GET /callback', () => {` and its matching closing `});`) with:

```typescript
describe('GET /callback', () => {
  it('rejects a callback whose state does not match the cookie', async () => {
    const req = new Request('http://localhost/callback?code=abc&state=wrong', {
      headers: { Cookie: 'wl_oauth_state=right' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it('creates a user, identity, and token row on a valid callback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(
            JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
            { status: 200 }
          );
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(
            JSON.stringify({
              id: 'spotify-xyz',
              email: 'user@example.com',
              images: [{ url: 'https://img.example/avatar.jpg' }],
              product: 'premium',
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Set-Cookie')).toContain('wl_session=');

    const identity = await env.DB.prepare(`SELECT * FROM auth_identities WHERE provider = 'spotify' AND provider_id = ?`)
      .bind('spotify-xyz')
      .first<any>();
    expect(identity).toBeTruthy();
    expect(identity.email).toBe('user@example.com');

    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(identity.user_id).first<any>();
    expect(user.email).toBe('user@example.com');

    const tokenRow = await env.DB.prepare(`SELECT * FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`)
      .bind(identity.user_id)
      .first<any>();
    expect(tokenRow.access_token).not.toBe('at'); // encrypted, not plaintext
    expect(tokenRow.avatar_url).toBe('https://img.example/avatar.jpg');
    expect(tokenRow.product_tier).toBe('premium');

    vi.unstubAllGlobals();
  });

  it('omits Secure on the session cookie over plain http, keeps it over https', async () => {
    const stubFetch = () =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.includes('accounts.spotify.com/api/token')) {
            return new Response(
              JSON.stringify({ access_token: 'at-secure-check', refresh_token: 'rt-secure-check', expires_in: 3600 }),
              { status: 200 }
            );
          }
          if (url.includes('api.spotify.com/v1/me')) {
            return new Response(JSON.stringify({ id: 'spotify-secure-check', email: 'sc@example.com' }), { status: 200 });
          }
          throw new Error(`unexpected fetch: ${url}`);
        })
      );

    stubFetch();
    const httpReq = new Request('http://127.0.0.1:8787/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const httpRes = await worker.fetch(httpReq, env, {} as ExecutionContext);
    expect(httpRes.headers.get('Set-Cookie')).not.toContain('Secure');
    vi.unstubAllGlobals();

    await env.DB.exec(
      `DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM auth_identities WHERE provider_id = 'spotify-secure-check');
       DELETE FROM music_source_tokens WHERE user_id IN (SELECT user_id FROM auth_identities WHERE provider_id = 'spotify-secure-check');
       DELETE FROM users WHERE id IN (SELECT user_id FROM auth_identities WHERE provider_id = 'spotify-secure-check');
       DELETE FROM auth_identities WHERE provider_id = 'spotify-secure-check';`
    );

    stubFetch();
    const httpsReq = new Request('https://wavelengthz.app/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const httpsRes = await worker.fetch(httpsReq, env, {} as ExecutionContext);
    expect(httpsRes.headers.get('Set-Cookie')).toContain('Secure');
    vi.unstubAllGlobals();
  });

  it('refreshes the stored Spotify avatar URL and payment status when an existing user logs in again', async () => {
    const now = Date.now();
    const userId = await insertTestUser(env.DB, {
      spotifyId: 'spotify-avatar-user',
      email: 'user@example.com',
      avatarUrl: 'https://img.example/old-avatar.jpg',
      productTier: 'free',
      onboardedAt: now,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'at4', refresh_token: 'rt4', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(
            JSON.stringify({
              id: 'spotify-avatar-user',
              email: 'user@example.com',
              images: [{ url: 'https://img.example/new-avatar.jpg' }],
              product: 'premium',
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);

    const tokenRow = await env.DB.prepare(`SELECT avatar_url, product_tier FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`)
      .bind(userId)
      .first<any>();
    expect(tokenRow.avatar_url).toBe('https://img.example/new-avatar.jpg');
    expect(tokenRow.product_tier).toBe('premium');

    vi.unstubAllGlobals();
  });

  it('redirects an existing user whose onboarding is incomplete to /onboarding', async () => {
    await insertTestUser(env.DB, { spotifyId: 'spotify-xyz', email: 'user@example.com', onboardedAt: null });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(
            JSON.stringify({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }),
            { status: 200 }
          );
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(
            JSON.stringify({ id: 'spotify-xyz', email: 'user@example.com' }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/onboarding');

    vi.unstubAllGlobals();
  });

  it('reactivates a soft-deleted account on login instead of leaving it unauthenticatable', async () => {
    const now = Date.now();
    await insertTestUser(env.DB, { spotifyId: 'spotify-soft-deleted', email: 'user@example.com', onboardedAt: now, deletedAt: now });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'at5', refresh_token: 'rt5', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(
            JSON.stringify({ id: 'spotify-soft-deleted', email: 'user@example.com' }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');

    const identity = await env.DB.prepare(`SELECT user_id FROM auth_identities WHERE provider_id = 'spotify-soft-deleted'`).first<any>();
    const user = await env.DB.prepare('SELECT deleted_at FROM users WHERE id = ?').bind(identity.user_id).first<any>();
    expect(user.deleted_at).toBeNull();

    vi.unstubAllGlobals();
  });

  it('redirects an existing, fully-onboarded user to /', async () => {
    const now = Date.now();
    await insertTestUser(env.DB, { spotifyId: 'spotify-onboarded', email: 'user2@example.com', onboardedAt: now });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(
            JSON.stringify({ access_token: 'at3', refresh_token: 'rt3', expires_in: 3600 }),
            { status: 200 }
          );
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(
            JSON.stringify({ id: 'spotify-onboarded', email: 'user2@example.com' }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');

    vi.unstubAllGlobals();
  });
});
```

Add the import at the top of the file: `import { insertTestUser } from '../helpers/createUser';`

Also update the `beforeEach` at the top of the file (currently `await env.DB.exec('DELETE FROM sessions; DELETE FROM users;');`) to also clear the new tables:

```typescript
beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
});
```

Finally, in the `POST /logout` describe block, find `'deletes the session row from the database so the cookie cannot be replayed'` and replace its inline `INSERT INTO users (...)` setup with:

```typescript
    await insertTestUser(env.DB, { id: 'user-logout-test', spotifyId: 'spotify-logout-test' });
```

(keeping the rest of that test unchanged).

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run test/routes/auth.test.ts`
Expected: PASS (all cases green)

- [ ] **Step 4: Commit**

```bash
git add src/routes/auth.ts test/routes/auth.test.ts
git commit -m "refactor: rewrite /callback as a 3-table write against the new auth tables"
```

---

### Task 4: `admin.ts` + `accountDeletion.ts` updates

**Files:**
- Modify: `src/routes/admin.ts`
- Modify: `src/lib/accountDeletion.ts`
- Modify: `test/routes/admin.test.ts`
- Modify: `test/lib/accountDeletion.test.ts`

**Interfaces:**
- Consumes: `auth_identities`, `music_source_tokens` (Task 1), `insertTestUser` (Task 1).
- Produces: `hardDeleteUser` also deletes the user's `auth_identities`/`music_source_tokens` rows. The dev-only hard-delete lookup in `admin.ts` resolves either an internal id or a Spotify id via `auth_identities`.

- [ ] **Step 1: Update `src/routes/admin.ts`'s hard-delete lookup**

Replace:

```typescript
    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ? OR spotify_id = ?')
      .bind(idParam, idParam)
      .first<{ id: string }>();
```

with:

```typescript
    const user = await env.DB.prepare(
      `SELECT u.id FROM users u
       LEFT JOIN auth_identities ai ON ai.user_id = u.id AND ai.provider = 'spotify'
       WHERE u.id = ? OR ai.provider_id = ?`
    )
      .bind(idParam, idParam)
      .first<{ id: string }>();
```

- [ ] **Step 2: Simplify `ensureTombstoneUser` and add cascade deletes in `src/lib/accountDeletion.ts`**

Replace:

```typescript
const TOMBSTONE_USER_ID = '00000000-0000-0000-0000-000000000000';
const TOMBSTONE_SPOTIFY_ID = '__wavelengthz_deleted_user_tombstone__';

async function ensureTombstoneUser(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, 'tombstone', 'tombstone', 0, 0, 0)`
  )
    .bind(TOMBSTONE_USER_ID, TOMBSTONE_SPOTIFY_ID)
    .run();
}
```

with:

```typescript
const TOMBSTONE_USER_ID = '00000000-0000-0000-0000-000000000000';
const TOMBSTONE_SPOTIFY_ID = '__wavelengthz_deleted_user_tombstone__';

// access_token/refresh_token/token_expires_at are dropped by Task 1's
// migration, so they're no longer supplied here. spotify_id stays --
// Task 1's migration note explains it's a platform constraint that it
// can't be dropped from users, so it's still UNIQUE NOT NULL. No
// auth_identities/music_source_tokens row is needed -- the tombstone
// never logs in, and nothing requires a user to have either.
async function ensureTombstoneUser(env: Env): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, spotify_id, created_at, updated_at) VALUES (?, ?, 0, 0)`)
    .bind(TOMBSTONE_USER_ID, TOMBSTONE_SPOTIFY_ID)
    .run();
}
```

In `hardDeleteUser`, add these two lines immediately before the existing `await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();`:

```typescript
  await env.DB.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM music_source_tokens WHERE user_id = ?').bind(userId).run();
```

- [ ] **Step 3: Update `test/lib/accountDeletion.test.ts`**

Replace the `seedFullUser` helper:

```typescript
async function seedFullUser(id: string) {
  await insertTestUser(env.DB, { id, spotifyId: `sp-${id}` });
}
```

Add the import: `import { insertTestUser } from '../helpers/createUser';`

Update the `beforeEach`'s cleanup exec to also clear the new tables:

```typescript
  await env.DB.exec(`
    DELETE FROM messages; DELETE FROM matches; DELETE FROM user_photos;
    DELETE FROM people_swipes; DELETE FROM music_swipes; DELETE FROM user_genres; DELETE FROM music_profiles;
    DELETE FROM blocks; DELETE FROM reports; DELETE FROM notifications; DELETE FROM sessions;
    DELETE FROM tracks; DELETE FROM artists;
    DELETE FROM music_source_tokens; DELETE FROM auth_identities;
    DELETE FROM users;
  `);
```

In the `'purges the user row, their photos (D1 + R2), and everything referencing them'` test, add these two assertions right after the existing `expect(... FROM users WHERE id = ?).toBeNull()` line:

```typescript
    expect(await env.DB.prepare('SELECT * FROM auth_identities WHERE user_id = ?').bind('u1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM music_source_tokens WHERE user_id = ?').bind('u1').first()).toBeNull();
```

- [ ] **Step 4: Update `test/routes/admin.test.ts`**

Read the file first — find its `INSERT INTO users` call site and replace it with `insertTestUser(env.DB, { ... })` using the same id/spotifyId values it currently hardcodes, adding the import `import { insertTestUser } from '../helpers/createUser';`. If the test looks up a user by Spotify id (exercising the `OR ai.provider_id = ?` branch added in Step 1), keep that assertion — it now proves the join-based lookup works, not just the `id` branch.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/routes/admin.test.ts test/lib/accountDeletion.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin.ts src/lib/accountDeletion.ts test/routes/admin.test.ts test/lib/accountDeletion.test.ts
git commit -m "refactor: cascade-delete auth tables on hard-delete, simplify tombstone user"
```

---

### Task 5: Sweep `test/lib` and `test/db` fixtures onto the shared helper

**Files:**
- Modify: `test/db/catalogRefresh.test.ts`
- Modify: `test/lib/artistTopUp.test.ts`
- Modify: `test/lib/catalogUpsert.test.ts`
- Modify: `test/lib/matching.test.ts`
- Modify: `test/lib/notifications.test.ts`
- Modify: `test/lib/profile.test.ts`

**Interfaces:**
- Consumes: `insertTestUser` (Task 1).

- [ ] **Step 1: Convert each file's `INSERT INTO users` call(s) to `insertTestUser`**

For each file listed above: add `import { insertTestUser } from '../helpers/createUser';` (adjust the relative path per the file's actual location), then read the file's current `INSERT INTO users (...)` statement(s) and replace each with an `insertTestUser(env.DB, { ... })` call carrying forward exactly the same field values that call site currently sets (e.g. a call setting `lat`/`lng`/`max_distance_km` passes those as `{ lat, lng, maxDistanceKm }`; a call setting only `id`/`spotify_id` passes `{ id, spotifyId }`). The helper's full override list is in `test/helpers/createUser.ts` (Task 1) — every field these files currently set has a corresponding override.

Two fully worked examples from files in this task's scope:

`test/lib/matching.test.ts` currently has (approximately):
```typescript
await env.DB.prepare(
  `INSERT INTO users (id, spotify_id, lat, lng, max_distance_km, access_token, refresh_token, token_expires_at, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, 'a', 'r', 9999999999999, 1000, 1000)`
).bind(id, `sp-${id}`, lat, lng, maxDistanceKm).run();
```
becomes:
```typescript
await insertTestUser(env.DB, { id, spotifyId: `sp-${id}`, lat, lng, maxDistanceKm, createdAt: 1000, updatedAt: 1000 });
```

`test/lib/accountDeletion.test.ts`-style pattern (for reference, already done in Task 4) — a bare `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at) VALUES (?, ?, 'a', 'r', 9999999999999, 1000, 1000)` becomes `insertTestUser(env.DB, { id, spotifyId: \`sp-${id}\` })` (the helper's own defaults for `accessToken`/`refreshToken`/`tokenExpiresAt`/`createdAt`/`updatedAt` are equivalent for test purposes — only pass `createdAt`/`updatedAt` explicitly if a test asserts on those exact values).

If a file's `beforeEach`/cleanup does `DELETE FROM users` (or similar), add `DELETE FROM music_source_tokens; DELETE FROM auth_identities;` before it, matching the FK-safe "children before parents" ordering already established in `test/lib/accountDeletion.test.ts`.

- [ ] **Step 2: Run the affected tests**

Run: `npx vitest run test/db/catalogRefresh.test.ts test/lib/artistTopUp.test.ts test/lib/catalogUpsert.test.ts test/lib/matching.test.ts test/lib/notifications.test.ts test/lib/profile.test.ts`
Expected: PASS, no assertion changes needed beyond the setup rewrite (none of these files assert on the six removed columns directly — confirm this holds; if one does, adapt that specific assertion to query the appropriate new table instead).

- [ ] **Step 3: Commit**

```bash
git add test/db/catalogRefresh.test.ts test/lib/artistTopUp.test.ts test/lib/catalogUpsert.test.ts test/lib/matching.test.ts test/lib/notifications.test.ts test/lib/profile.test.ts
git commit -m "test: convert lib/db test fixtures to the shared insertTestUser helper"
```

---

### Task 6: Sweep smaller `test/routes` fixtures onto the shared helper

**Files:**
- Modify: `test/routes/account.test.ts`
- Modify: `test/routes/groups.test.ts`
- Modify: `test/routes/matches.test.ts`
- Modify: `test/routes/musicSwipes.test.ts`
- Modify: `test/routes/notifications.test.ts`
- Modify: `test/routes/onboarding.test.ts`
- Modify: `test/routes/safety.test.ts`

**Interfaces:**
- Consumes: `insertTestUser` (Task 1).

- [ ] **Step 1: Convert each file's `INSERT INTO users` call(s) to `insertTestUser`**

Same transformation as Task 5, Step 1 — add the import, read each file's current `INSERT INTO users` statement(s), and replace with an equivalent `insertTestUser(env.DB, { ... })` call preserving every field value that call site currently sets. `musicSwipes.test.ts` and `notifications.test.ts` each have two call sites; the rest have one each — convert all of them per file.

If any of these files' cleanup `DELETE`s from `users`, add `DELETE FROM music_source_tokens; DELETE FROM auth_identities;` beforehand (FK-safe ordering, same as Task 5).

- [ ] **Step 2: Run the affected tests**

Run: `npx vitest run test/routes/account.test.ts test/routes/groups.test.ts test/routes/matches.test.ts test/routes/musicSwipes.test.ts test/routes/notifications.test.ts test/routes/onboarding.test.ts test/routes/safety.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/routes/account.test.ts test/routes/groups.test.ts test/routes/matches.test.ts test/routes/musicSwipes.test.ts test/routes/notifications.test.ts test/routes/onboarding.test.ts test/routes/safety.test.ts
git commit -m "test: convert more route test fixtures to the shared insertTestUser helper"
```

---

### Task 7: Sweep remaining `test/routes` fixtures, final full-suite verification

**Files:**
- Modify: `test/routes/catalog.test.ts`
- Modify: `test/routes/me.test.ts`
- Modify: `test/routes/peopleSwipes.test.ts`
- Modify: `test/routes/photos.test.ts`

**Interfaces:**
- Consumes: `insertTestUser` (Task 1).

- [ ] **Step 1: Convert each file's `INSERT INTO users` call(s) to `insertTestUser`**

Same transformation as Tasks 5-6. `test/routes/peopleSwipes.test.ts` has the most call sites (7) and the widest field variety (`lat`, `lng`, `maxDistanceKm`, `onboardedAt`, `gender`, `seeking`, `email`, `dateOfBirth`, `ageMin`, `ageMax`) — every one of those fields has a corresponding `insertTestUser` override, so each call site converts directly. `test/routes/catalog.test.ts` and `test/routes/me.test.ts` have 4 each.

Worked example from `test/routes/peopleSwipes.test.ts`'s widest-field call site:
```typescript
await env.DB.prepare(
  `INSERT INTO users (id, spotify_id, lat, lng, max_distance_km, onboarded_at, gender, seeking, date_of_birth, age_min, age_max, access_token, refresh_token, token_expires_at, created_at, updated_at)
   VALUES (?, ?, 30.27, -97.74, 80, 1000, 'female', 'female', ?, ?, ?, 'a', 'r', 9999999999999, 1000, 1000)`
).bind(id, `sp-${id}`, dateOfBirth, ageMin, ageMax).run();
```
becomes:
```typescript
await insertTestUser(env.DB, {
  id, spotifyId: `sp-${id}`, lat: 30.27, lng: -97.74, maxDistanceKm: 80, onboardedAt: 1000,
  gender: 'female', seeking: 'female', dateOfBirth, ageMin, ageMax, createdAt: 1000, updatedAt: 1000,
});
```

- [ ] **Step 2: Run the affected tests**

Run: `npx vitest run test/routes/catalog.test.ts test/routes/me.test.ts test/routes/peopleSwipes.test.ts test/routes/photos.test.ts`
Expected: PASS

- [ ] **Step 3: Run the full suite and type-check — this is the real gate for the whole plan**

Run: `npx vitest run`
Expected: every test file passes (45 files, matching or exceeding the pre-refactor 459-test baseline).

Run: `npx tsc --noEmit`
Expected: zero errors.

If either fails anywhere outside the four files this task touches, that's a signal an earlier task (2-6) missed something — identify which file/assertion still references a removed column or the old table shape, and fix it directly (it's a leftover from this refactor, not new scope).

- [ ] **Step 4: Commit**

```bash
git add test/routes/catalog.test.ts test/routes/me.test.ts test/routes/peopleSwipes.test.ts test/routes/photos.test.ts
git commit -m "test: convert final route test fixtures to the shared insertTestUser helper"
```
