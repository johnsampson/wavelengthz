# Wavelengthz Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status:** Tasks 1-19 below are the original plan and are fully implemented and merged. Substantial work has continued since via direct iteration against real usage (not the formal task loop) — see **Post-Launch Changes** at the end of this document for everything built or fixed after Task 19, including schema changes and one correction to a Global Constraint below (photo uploads).

**Goal:** Build the Wavelengthz v1 app end-to-end per `docs/PLAN.md` — Spotify OAuth login, two swipe modes (people + music), a growing searchable artist/track catalog, blended match scoring with like-priority, messaging, trust & safety, transactional notifications, and a mobile-first PWA — on Cloudflare Workers + D1 + R2.

**Architecture:** Single Cloudflare Worker (`src/index.ts`) routing via `itty-router` to per-domain route modules under `src/routes/`, backed by D1 (SQLite) for all relational data and R2 for photo blobs. Server-rendered-free static frontend (`public/`) using Alpine.js for reactivity, plain CSS (mobile-first, Tailwind CLI build), no SPA framework, per the plan's performance budget (§11).

**Tech Stack:** TypeScript, Cloudflare Workers, `wrangler`, D1, R2, `itty-router` (~450B router), Alpine.js (~15KB), Tailwind CLI, Vitest + `@cloudflare/vitest-pool-workers` for tests, Resend (transactional email), Sentry (error tracking).

## Global Constraints

- All Spotify tokens (`access_token`, `refresh_token`) are encrypted at rest using AES-GCM before being written to D1 — never store plaintext tokens (docs/PLAN.md §13).
- Session cookies are `HttpOnly`, `Secure`, `SameSite=Lax` (docs/PLAN.md §13).
- OAuth login uses a `state` param stored in a short-lived cookie and verified on callback, for CSRF protection (docs/PLAN.md §13).
- Spotify Client Secret and the token-encryption key live only in Worker Secrets (`wrangler secret put`), never in `wrangler.toml` or committed files (docs/PLAN.md §13).
- ~~Photo uploads go through signed, short-lived R2 upload URLs issued by the Worker — photo bytes never route through the Worker body (docs/PLAN.md §13).~~ **Superseded post-launch:** photo bytes now route through the Worker body (`POST /api/photos` writes via the `env.PHOTOS` binding directly). A presigned-URL upload hits R2's real endpoint directly, which is a different storage backend from the `env.PHOTOS` binding in local dev — uploads "succeeded" into a bucket the app's own read path could never see. See Post-Launch Changes.
- Never expose a user's precise `lat`/`lng` to any other user via API response or UI — only a rounded, bucketed distance string (docs/PLAN.md §7.2).
- `notifications.type` is constrained to `'match' | 'message'` only — no engagement-bait notification types, ever (docs/PLAN.md §10).
- Every mutation to `people_swipes`/`music_swipes` uses the table's `UNIQUE` constraint as an upsert (`INSERT ... ON CONFLICT ... DO UPDATE`), never a delete-then-insert (docs/PLAN.md §3).
- Candidate queries (`/api/candidates/people`) exclude blocked users bidirectionally and unmatched pairs at the SQL level, not client-side (docs/PLAN.md §3, §9).
- No React/Vue/heavy JS framework, no animation library, no Tailwind CDN script in production (docs/PLAN.md §11).
- Age gate is a hard block: computed age under 18 from `date_of_birth` prevents account creation entirely (docs/PLAN.md §8).
- Money/currency, native app binaries, automated photo moderation, and push notifications are explicitly out of scope for this plan (docs/PLAN.md §1).

---

### Task 1: Project scaffold, tooling, and D1 schema

**Files:**
- Create: `package.json`
- Create: `wrangler.toml`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `src/db/schema.sql`
- Create: `test/apply-schema.ts`
- Create: `test/index.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Produces: `wrangler.toml` binds D1 as `env.DB`, R2 bucket as `env.PHOTOS`, and declares secrets `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`, `RESEND_API_KEY`, `SENTRY_DSN` (referenced, not set — set via `wrangler secret put` locally, not committed).
- Produces: `src/index.ts` exports a default object with a `fetch(request, env, ctx)` handler and an `itty-router` instance named `router`, exported as `router` for later tasks to attach routes to via `router.get(...)`/`router.post(...)`.
- Produces: `test/apply-schema.ts` exports `async function applySchema(db: D1Database): Promise<void>` which every later test file imports to set up a clean schema against the test D1 binding.

- [ ] **Step 1: Initialize package.json and install dependencies**

```bash
npm init -y
npm install itty-router
npm install -D typescript wrangler vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types
```

- [ ] **Step 2: Write `wrangler.toml`**

```toml
name = "wavelengthz"
main = "src/index.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "wavelengthz-db"
database_id = "REPLACE_WITH_REAL_ID_AFTER_wrangler_d1_create"

[[r2_buckets]]
binding = "PHOTOS"
bucket_name = "wavelengthz-photos"

[vars]
SPOTIFY_REDIRECT_URI = "http://localhost:8787/callback"

[env.test]
[[env.test.d1_databases]]
binding = "DB"
database_name = "wavelengthz-db-test"
database_id = "test-id"

[[env.test.r2_buckets]]
binding = "PHOTOS"
bucket_name = "wavelengthz-photos-test"
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
.wrangler/
dist/
.dev.vars
*.log
```

- [ ] **Step 5: Write `src/db/schema.sql`**

Copy verbatim from `docs/PLAN.md` §3 (the full `CREATE TABLE`/`CREATE INDEX` block, lines 70-231 of that file) into this new file unmodified — it is already a complete, ready-to-run schema.

- [ ] **Step 6: Write `test/apply-schema.ts`**

```typescript
import { readFileSync } from 'node:fs';
import path from 'node:path';

export async function applySchema(db: D1Database): Promise<void> {
  const sql = readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf-8');
  await db.exec(sql);
}
```

- [ ] **Step 7: Write `vitest.config.ts`**

```typescript
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml', environment: 'test' },
      },
    },
  },
});
```

- [ ] **Step 8: Write the failing test for the base router**

```typescript
// test/index.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applySchema } from './apply-schema';
import worker from '../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

describe('worker root', () => {
  it('returns 404 for an unknown route', async () => {
    const req = new Request('http://localhost/does-not-exist');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(404);
  });

  it('DB binding has the users table after schema apply', async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
    ).first();
    expect(result?.name).toBe('users');
  });
});
```

- [ ] **Step 9: Run test to verify it fails**

Run: `npx vitest run test/index.test.ts`
Expected: FAIL — `src/index.ts` does not exist yet, or has no default export.

- [ ] **Step 10: Write `src/index.ts`**

```typescript
import { Router } from 'itty-router';

export const router = Router();

router.all('*', () => new Response('Not found', { status: 404 }));

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    router.fetch(request, env, ctx),
};
```

- [ ] **Step 11: Run test to verify it passes**

Run: `npx vitest run test/index.test.ts`
Expected: PASS (2/2)

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json wrangler.toml tsconfig.json vitest.config.ts .gitignore src/index.ts src/db/schema.sql test/apply-schema.ts test/index.test.ts
git commit -m "chore: scaffold Worker project, D1 schema, and test harness"
```

---

### Task 2: Crypto and session libraries

**Files:**
- Create: `src/lib/crypto.ts`
- Create: `src/lib/session.ts`
- Test: `test/lib/crypto.test.ts`
- Test: `test/lib/session.test.ts`

**Interfaces:**
- Consumes: `env.DB` (D1Database), `env.TOKEN_ENCRYPTION_KEY` (string, base64-encoded 32-byte key) from Task 1's `wrangler.toml`/`Env` type.
- Produces: `encrypt(plaintext: string, base64Key: string): Promise<string>` and `decrypt(ciphertext: string, base64Key: string): Promise<string>` from `src/lib/crypto.ts` — later tasks (Task 3) use these for Spotify tokens.
- Produces: `createSession(db: D1Database, userId: string): Promise<{ id: string; cookie: string }>`, `getSessionUser(request: Request, db: D1Database): Promise<UserRow | null>`, and `sessionCookieHeader(id: string, maxAgeSeconds: number): string` from `src/lib/session.ts` — later tasks use `getSessionUser` as the auth check on every protected route.
- Produces: `UserRow` type (matches the `users` table columns) exported from `src/lib/session.ts` for reuse across route modules.

- [ ] **Step 1: Write the failing test for crypto round-trip**

```typescript
// test/lib/crypto.test.ts
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../src/lib/crypto';

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='; // base64, 32 bytes

describe('crypto', () => {
  it('round-trips plaintext through encrypt/decrypt', async () => {
    const ciphertext = await encrypt('spotify-refresh-token-abc123', KEY);
    expect(ciphertext).not.toContain('spotify-refresh-token-abc123');
    const plaintext = await decrypt(ciphertext, KEY);
    expect(plaintext).toBe('spotify-refresh-token-abc123');
  });

  it('produces different ciphertext for the same plaintext on repeat calls', async () => {
    const a = await encrypt('same-input', KEY);
    const b = await encrypt('same-input', KEY);
    expect(a).not.toBe(b); // random IV each time
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/crypto.test.ts`
Expected: FAIL — `src/lib/crypto.ts` does not exist.

- [ ] **Step 3: Write `src/lib/crypto.ts`**

```typescript
function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = b64ToBytes(base64Key);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encrypt(plaintext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertextBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertextBuf), iv.length);
  return bytesToB64(combined);
}

export async function decrypt(ciphertext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const combined = b64ToBytes(ciphertext);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(plaintextBuf);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/crypto.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Write the failing test for session creation and lookup**

```typescript
// test/lib/session.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession, getSessionUser, sessionCookieHeader } from '../../src/lib/session';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM users;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'spotify-u1', 'enc-access', 'enc-refresh', 9999999999, 1000, 1000)`
  ).run();
});

describe('session', () => {
  it('creates a session row and returns a Set-Cookie-ready cookie string', async () => {
    const { id, cookie } = await createSession(env.DB, 'u1');
    expect(id).toBeTruthy();
    expect(cookie).toContain('wl_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('resolves the user from a request carrying the session cookie', async () => {
    const { id } = await createSession(env.DB, 'u1');
    const req = new Request('http://localhost/api/me', {
      headers: { Cookie: `wl_session=${id}` },
    });
    const user = await getSessionUser(req, env.DB);
    expect(user?.id).toBe('u1');
  });

  it('returns null when there is no session cookie', async () => {
    const req = new Request('http://localhost/api/me');
    const user = await getSessionUser(req, env.DB);
    expect(user).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const id = 'expired-session';
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 'u1', 1000, 1001)`
    ).bind(id).run();
    const req = new Request('http://localhost/api/me', {
      headers: { Cookie: `wl_session=${id}` },
    });
    const user = await getSessionUser(req, env.DB);
    expect(user).toBeNull();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/lib/session.test.ts`
Expected: FAIL — `src/lib/session.ts` does not exist.

- [ ] **Step 7: Write `src/lib/session.ts`**

```typescript
export interface UserRow {
  id: string;
  spotify_id: string;
  display_name: string | null;
  bio: string | null;
  date_of_birth: string | null;
  age_verified_at: number | null;
  location_label: string | null;
  lat: number | null;
  lng: number | null;
  max_distance_km: number;
  email: string | null;
  access_token: string;
  refresh_token: string;
  token_expires_at: number;
  onboarded_at: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function sessionCookieHeader(id: string, maxAgeSeconds: number): string {
  return `wl_session=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export async function createSession(
  db: D1Database,
  userId: string
): Promise<{ id: string; cookie: string }> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_SECONDS * 1000;
  await db
    .prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(id, userId, now, expiresAt)
    .run();
  return { id, cookie: sessionCookieHeader(id, SESSION_TTL_SECONDS) };
}

function parseCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export async function getSessionUser(request: Request, db: D1Database): Promise<UserRow | null> {
  const sessionId = parseCookie(request, 'wl_session');
  if (!sessionId) return null;

  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.deleted_at IS NULL`
    )
    .bind(sessionId, Date.now())
    .first<UserRow>();

  return row ?? null;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/lib/session.test.ts`
Expected: PASS (4/4)

- [ ] **Step 9: Commit**

```bash
git add src/lib/crypto.ts src/lib/session.ts test/lib/crypto.test.ts test/lib/session.test.ts
git commit -m "feat: add token encryption and session management libraries"
```

---

### Task 3: Spotify OAuth flow (login, callback, logout)

**Files:**
- Create: `src/lib/spotify.ts`
- Create: `src/routes/auth.ts`
- Modify: `src/index.ts` (register auth routes)
- Test: `test/lib/spotify.test.ts`
- Test: `test/routes/auth.test.ts`

**Interfaces:**
- Consumes: `encrypt`/`decrypt` (Task 2, `src/lib/crypto.ts`), `createSession`/`sessionCookieHeader` (Task 2, `src/lib/session.ts`), `router` export (Task 1, `src/index.ts`).
- Produces: `buildAuthUrl(state: string, env: Env): string`, `exchangeCodeForToken(code: string, env: Env): Promise<SpotifyTokenResponse>`, `refreshAccessToken(refreshToken: string, env: Env): Promise<SpotifyTokenResponse>`, `fetchSpotifyProfile(accessToken: string): Promise<{ id: string; email?: string }>` from `src/lib/spotify.ts` — Task 4 uses `refreshAccessToken` and the profile fetch pattern.
- Produces: `SpotifyTokenResponse` type `{ access_token: string; refresh_token: string; expires_in: number }`, exported from `src/lib/spotify.ts`.
- Produces: routes `GET /login`, `GET /callback`, `POST /logout` registered on `router` from `src/routes/auth.ts`'s exported `registerAuthRoutes(router: RouterType): void`.

- [ ] **Step 1: Write the failing test for the Spotify auth URL builder**

```typescript
// test/lib/spotify.test.ts
import { describe, it, expect } from 'vitest';
import { buildAuthUrl } from '../../src/lib/spotify';

const env = {
  SPOTIFY_CLIENT_ID: 'client123',
  SPOTIFY_REDIRECT_URI: 'http://localhost:8787/callback',
} as any;

describe('buildAuthUrl', () => {
  it('builds a Spotify authorize URL with client id, redirect uri, scope, and state', () => {
    const url = new URL(buildAuthUrl('state-abc', env));
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('client123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('scope')).toContain('user-top-read');
    expect(url.searchParams.get('scope')).toContain('user-read-email');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/spotify.test.ts`
Expected: FAIL — `src/lib/spotify.ts` does not exist.

- [ ] **Step 3: Write `src/lib/spotify.ts`**

```typescript
export interface SpotifyTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const SCOPES = ['user-top-read', 'user-read-email'].join(' ');

export function buildAuthUrl(state: string, env: Env): string {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('client_id', env.SPOTIFY_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.SPOTIFY_REDIRECT_URI);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

function basicAuthHeader(env: Env): string {
  return 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
}

export async function exchangeCodeForToken(
  code: string,
  env: Env
): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(env),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`Spotify token exchange failed: ${res.status}`);
  return res.json();
}

export async function refreshAccessToken(
  refreshToken: string,
  env: Env
): Promise<SpotifyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(env),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`Spotify token refresh failed: ${res.status}`);
  const data = await res.json<SpotifyTokenResponse>();
  return { ...data, refresh_token: data.refresh_token ?? refreshToken };
}

export async function fetchSpotifyProfile(
  accessToken: string
): Promise<{ id: string; email?: string }> {
  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Spotify profile fetch failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/spotify.test.ts`
Expected: PASS (1/1)

- [ ] **Step 5: Write the failing test for the auth routes**

```typescript
// test/routes/auth.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM users;');
});

describe('GET /login', () => {
  it('redirects to Spotify authorize with a state cookie set', async () => {
    const req = new Request('http://localhost/login');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('https://accounts.spotify.com/authorize');
    const setCookie = res.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('wl_oauth_state=');
  });
});

describe('GET /callback', () => {
  it('rejects a callback whose state does not match the cookie', async () => {
    const req = new Request('http://localhost/callback?code=abc&state=wrong', {
      headers: { Cookie: 'wl_oauth_state=right' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it('creates a user and session on a valid callback', async () => {
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
    expect(res.headers.get('Set-Cookie')).toContain('wl_session=');

    const row = await env.DB.prepare('SELECT * FROM users WHERE spotify_id = ?')
      .bind('spotify-xyz')
      .first<any>();
    expect(row).toBeTruthy();
    expect(row.email).toBe('user@example.com');
    expect(row.access_token).not.toBe('at'); // encrypted, not plaintext

    vi.unstubAllGlobals();
  });
});

describe('POST /logout', () => {
  it('clears the session cookie', async () => {
    const req = new Request('http://localhost/logout', { method: 'POST' });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('wl_session=;');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/routes/auth.test.ts`
Expected: FAIL — `/login`, `/callback`, `/logout` all 404 (not yet registered).

- [ ] **Step 7: Write `src/routes/auth.ts`**

```typescript
import type { IRequest, RouterType } from 'itty-router';
import { buildAuthUrl, exchangeCodeForToken, fetchSpotifyProfile } from '../lib/spotify';
import { encrypt } from '../lib/crypto';
import { createSession } from '../lib/session';

function parseCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export function registerAuthRoutes(router: RouterType) {
  router.get('/login', async (request: IRequest, env: Env) => {
    const state = crypto.randomUUID();
    const authUrl = buildAuthUrl(state, env);
    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl,
        'Set-Cookie': `wl_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    });
  });

  router.get('/callback', async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieState = parseCookie(request, 'wl_oauth_state');

    if (!code || !state || !cookieState || state !== cookieState) {
      return new Response('Invalid OAuth state', { status: 400 });
    }

    const token = await exchangeCodeForToken(code, env);
    const profile = await fetchSpotifyProfile(token.access_token);

    const encryptedAccess = await encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY);
    const encryptedRefresh = await encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY);
    const now = Date.now();
    const expiresAt = now + token.expires_in * 1000;

    const existing = await env.DB.prepare('SELECT id FROM users WHERE spotify_id = ?')
      .bind(profile.id)
      .first<{ id: string }>();

    const userId = existing?.id ?? crypto.randomUUID();

    if (existing) {
      await env.DB.prepare(
        `UPDATE users SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(encryptedAccess, encryptedRefresh, expiresAt, now, userId).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO users (id, spotify_id, email, access_token, refresh_token, token_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(userId, profile.id, profile.email ?? null, encryptedAccess, encryptedRefresh, expiresAt, now, now).run();
    }

    const { cookie } = await createSession(env.DB, userId);

    return new Response(null, {
      status: 302,
      headers: {
        Location: existing ? '/' : '/onboarding.html',
        'Set-Cookie': cookie,
      },
    });
  });

  router.post('/logout', async () => {
    return new Response('ok', {
      status: 200,
      headers: {
        'Set-Cookie': 'wl_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      },
    });
  });
}
```

- [ ] **Step 8: Wire auth routes into `src/index.ts`**

```typescript
// src/index.ts — replace the file contents with:
import { Router } from 'itty-router';
import { registerAuthRoutes } from './routes/auth';

export const router = Router();

registerAuthRoutes(router);

router.all('*', () => new Response('Not found', { status: 404 }));

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    router.fetch(request, env, ctx),
};
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/routes/auth.test.ts test/index.test.ts`
Expected: PASS (all)

- [ ] **Step 10: Commit**

```bash
git add src/lib/spotify.ts src/routes/auth.ts src/index.ts test/lib/spotify.test.ts test/routes/auth.test.ts
git commit -m "feat: implement Spotify OAuth login/callback/logout flow"
```

---

### Task 4: Music profile pull, token refresh, and `/api/me`

**Files:**
- Modify: `src/lib/spotify.ts` (add top-artists/top-tracks fetchers)
- Create: `src/lib/tokens.ts`
- Create: `src/routes/me.ts`
- Modify: `src/index.ts` (register `/api/me`)
- Test: `test/lib/tokens.test.ts`
- Test: `test/routes/me.test.ts`

**Interfaces:**
- Consumes: `decrypt`/`encrypt` (Task 2), `getSessionUser`/`UserRow` (Task 2), `refreshAccessToken` (Task 3).
- Produces: `getValidAccessToken(user: UserRow, env: Env): Promise<string>` from `src/lib/tokens.ts` — decrypts the stored access token, refreshes via Spotify if `token_expires_at` has passed, persists the new encrypted tokens to `users`, and returns a usable plaintext access token. Later tasks (Task 5, Task 9) call this before any Spotify API request on behalf of a user.
- Produces: `fetchTopArtists(accessToken: string, timeRange: string): Promise<Array<{ id: string; name: string; genres: string[]; rank: number }>>` and `fetchTopTracks(accessToken: string, timeRange: string): Promise<Array<{ id: string; name: string; rank: number }>>`, added to `src/lib/spotify.ts`.
- Produces: `GET /api/me` route returning `{ user: {...}, musicProfile: {...} | null }`, JSON, 401 if unauthenticated.

- [ ] **Step 1: Write the failing test for token refresh**

```typescript
// test/lib/tokens.test.ts
import { describe, it, expect, vi } from 'vitest';
import { getValidAccessToken } from '../../src/lib/tokens';
import { encrypt } from '../../src/lib/crypto';

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const env = {
  TOKEN_ENCRYPTION_KEY: KEY,
  SPOTIFY_CLIENT_ID: 'id',
  SPOTIFY_CLIENT_SECRET: 'secret',
} as any;

describe('getValidAccessToken', () => {
  it('returns the decrypted token directly when not expired', async () => {
    const encAccess = await encrypt('valid-access-token', KEY);
    const encRefresh = await encrypt('refresh-token', KEY);
    const user = {
      id: 'u1',
      access_token: encAccess,
      refresh_token: encRefresh,
      token_expires_at: Date.now() + 1000 * 60 * 60,
    } as any;
    const db = { prepare: vi.fn() } as any;

    const token = await getValidAccessToken(user, env, db);
    expect(token).toBe('valid-access-token');
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('refreshes and persists new tokens when expired', async () => {
    const encAccess = await encrypt('stale-access-token', KEY);
    const encRefresh = await encrypt('refresh-token', KEY);
    const user = {
      id: 'u1',
      access_token: encAccess,
      refresh_token: encRefresh,
      token_expires_at: Date.now() - 1000,
    } as any;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access_token: 'fresh-access-token', refresh_token: 'refresh-token', expires_in: 3600 }),
          { status: 200 }
        )
      )
    );

    const run = vi.fn().mockResolvedValue({});
    const bind = vi.fn().mockReturnValue({ run });
    const db = { prepare: vi.fn().mockReturnValue({ bind }) } as any;

    const token = await getValidAccessToken(user, env, db);
    expect(token).toBe('fresh-access-token');
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'));

    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/tokens.test.ts`
Expected: FAIL — `src/lib/tokens.ts` does not exist.

- [ ] **Step 3: Add fetchers to `src/lib/spotify.ts`**

Append to the existing file:

```typescript
export async function fetchTopArtists(
  accessToken: string,
  timeRange: string
): Promise<Array<{ id: string; name: string; genres: string[]; rank: number }>> {
  const res = await fetch(
    `https://api.spotify.com/v1/me/top/artists?time_range=${timeRange}&limit=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Spotify top artists fetch failed: ${res.status}`);
  const data = await res.json<{ items: Array<{ id: string; name: string; genres: string[] }> }>();
  return data.items.map((item, i) => ({ ...item, rank: i + 1 }));
}

export async function fetchTopTracks(
  accessToken: string,
  timeRange: string
): Promise<Array<{ id: string; name: string; rank: number }>> {
  const res = await fetch(
    `https://api.spotify.com/v1/me/top/tracks?time_range=${timeRange}&limit=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Spotify top tracks fetch failed: ${res.status}`);
  const data = await res.json<{ items: Array<{ id: string; name: string }> }>();
  return data.items.map((item, i) => ({ ...item, rank: i + 1 }));
}
```

- [ ] **Step 4: Write `src/lib/tokens.ts`**

```typescript
import { decrypt, encrypt } from './crypto';
import { refreshAccessToken } from './spotify';
import type { UserRow } from './session';

export async function getValidAccessToken(user: UserRow, env: Env, db: D1Database): Promise<string> {
  if (user.token_expires_at > Date.now()) {
    return decrypt(user.access_token, env.TOKEN_ENCRYPTION_KEY);
  }

  const refreshToken = await decrypt(user.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  const fresh = await refreshAccessToken(refreshToken, env);

  const encAccess = await encrypt(fresh.access_token, env.TOKEN_ENCRYPTION_KEY);
  const encRefresh = await encrypt(fresh.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  const expiresAt = Date.now() + fresh.expires_in * 1000;

  await db
    .prepare(`UPDATE users SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ? WHERE id = ?`)
    .bind(encAccess, encRefresh, expiresAt, Date.now(), user.id)
    .run();

  return fresh.access_token;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/lib/tokens.test.ts`
Expected: PASS (2/2)

- [ ] **Step 6: Write the failing test for `/api/me`**

```typescript
// test/routes/me.test.ts
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
  await env.DB.exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM music_profiles;');
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
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/routes/me.test.ts`
Expected: FAIL — `/api/me` not registered.

- [ ] **Step 8: Write `src/routes/me.ts`**

```typescript
import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { getValidAccessToken } from '../lib/tokens';
import { fetchTopArtists, fetchTopTracks } from '../lib/spotify';

const TIME_RANGE = 'medium_term';

export function registerMeRoutes(router: RouterType) {
  router.get('/api/me', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    let profile = await env.DB.prepare('SELECT * FROM music_profiles WHERE user_id = ?')
      .bind(user.id)
      .first<any>();

    if (!profile) {
      const accessToken = await getValidAccessToken(user, env, env.DB);
      const [artists, tracks] = await Promise.all([
        fetchTopArtists(accessToken, TIME_RANGE),
        fetchTopTracks(accessToken, TIME_RANGE),
      ]);
      const genreRank = new Map<string, number>();
      for (const artist of artists) {
        for (const genre of artist.genres) {
          if (!genreRank.has(genre)) genreRank.set(genre, genreRank.size + 1);
        }
      }
      const topArtists = JSON.stringify(artists.map((a) => ({ artist_id: a.id, rank: a.rank })));
      const topTracks = JSON.stringify(tracks.map((t) => ({ track_id: t.id, rank: t.rank })));
      const topGenres = JSON.stringify([...genreRank.keys()]);
      const now = Date.now();

      await env.DB.prepare(
        `INSERT INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(user.id, topArtists, topTracks, topGenres, TIME_RANGE, now).run();

      profile = { user_id: user.id, top_artists: topArtists, top_tracks: topTracks, top_genres: topGenres, time_range: TIME_RANGE, refreshed_at: now };
    }

    const { access_token, refresh_token, ...safeUser } = user;
    return Response.json({ user: safeUser, musicProfile: profile });
  });
}
```

- [ ] **Step 9: Register route in `src/index.ts`**

```typescript
// src/index.ts — add alongside registerAuthRoutes
import { registerMeRoutes } from './routes/me';
// ...
registerAuthRoutes(router);
registerMeRoutes(router);
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run test/routes/me.test.ts`
Expected: PASS (2/2)

- [ ] **Step 11: Commit**

```bash
git add src/lib/spotify.ts src/lib/tokens.ts src/routes/me.ts src/index.ts test/lib/tokens.test.ts test/routes/me.test.ts
git commit -m "feat: pull and cache Spotify music profile via /api/me"
```

---

### Task 5: Catalog seed script (~50 artists across genres)

**Files:**
- Modify: `src/lib/spotify.ts` (add client-credentials + search)
- Create: `src/db/seed.ts`
- Create: `src/routes/admin.ts`
- Modify: `src/index.ts` (register admin route)
- Test: `test/db/seed.test.ts`
- Test: `test/routes/admin.test.ts`

**Interfaces:**
- Produces: `getClientCredentialsToken(env: Env): Promise<string>`, `searchArtistsByGenre(token: string, genre: string, limit: number): Promise<Array<{ id: string; name: string; genres: string[]; images: Array<{ url: string }>; popularity: number }>>`, `fetchArtistTopTracks(token: string, artistId: string, market: string): Promise<Array<{ id: string; name: string; album: { images: Array<{ url: string }> }; preview_url: string | null }>>` added to `src/lib/spotify.ts`.
- Produces: `SEED_GENRES: string[]` and `seedCatalog(env: Env): Promise<{ artistsInserted: number; tracksInserted: number }>` from `src/db/seed.ts` — inserts rows with `source = 'seed'`, `approved = 1`, `added_by_user_id = null`. Task 9 (catalog search-and-add) reuses the same `artists`/`tracks` insert shape with `source = 'spotify_search'`.
- Produces: `POST /internal/seed` route (header `X-Seed-Secret` must equal `env.SEED_SECRET`, else 403) that runs `seedCatalog` and returns `{ artistsInserted, tracksInserted }`.
- Global Constraint addition: `SEED_SECRET` is a Worker Secret (like `TOKEN_ENCRYPTION_KEY`), never committed.

- [ ] **Step 1: Write the failing test for seedCatalog**

```typescript
// test/db/seed.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { seedCatalog, SEED_GENRES } from '../../src/db/seed';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM tracks; DELETE FROM artists;');
});

describe('seedCatalog', () => {
  it('inserts artists and tracks across the seed genre list, deduped by id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('/v1/search')) {
          // every genre search returns the SAME artist id to exercise dedup
          return new Response(
            JSON.stringify({
              artists: {
                items: [
                  { id: 'artist-1', name: 'Shared Artist', genres: ['pop'], images: [{ url: 'http://img/a' }], popularity: 80 },
                ],
              },
            }),
            { status: 200 }
          );
        }
        if (url.includes('/top-tracks')) {
          return new Response(
            JSON.stringify({
              tracks: [
                { id: 'track-1', name: 'Song One', album: { images: [{ url: 'http://img/t1' }] }, preview_url: 'http://preview/1' },
                { id: 'track-2', name: 'Song Two', album: { images: [{ url: 'http://img/t2' }] }, preview_url: null },
              ],
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const result = await seedCatalog(env as any);

    expect(result.artistsInserted).toBe(1); // deduped across all SEED_GENRES
    expect(result.tracksInserted).toBe(2);

    const artist = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind('artist-1').first<any>();
    expect(artist.source).toBe('seed');
    expect(artist.approved).toBe(1);
    expect(artist.added_by_user_id).toBeNull();

    const trackCount = await env.DB.prepare('SELECT COUNT(*) as c FROM tracks WHERE artist_id = ?').bind('artist-1').first<any>();
    expect(trackCount.c).toBe(2);

    vi.unstubAllGlobals();
  });

  it('exposes a genre list of at least 10 genres', () => {
    expect(SEED_GENRES.length).toBeGreaterThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/seed.test.ts`
Expected: FAIL — `src/db/seed.ts` does not exist.

- [ ] **Step 3: Add client-credentials + search to `src/lib/spotify.ts`**

Append to the existing file:

```typescript
export async function getClientCredentialsToken(env: Env): Promise<string> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Spotify client-credentials fetch failed: ${res.status}`);
  const data = await res.json<{ access_token: string }>();
  return data.access_token;
}

export async function searchArtistsByGenre(token: string, genre: string, limit: number) {
  const res = await fetch(
    `https://api.spotify.com/v1/search?type=artist&limit=${limit}&q=${encodeURIComponent(`genre:"${genre}"`)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Spotify artist search failed: ${res.status}`);
  const data = await res.json<{ artists: { items: any[] } }>();
  return data.artists.items;
}

export async function fetchArtistTopTracks(token: string, artistId: string, market = 'US') {
  const res = await fetch(
    `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=${market}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Spotify top tracks (artist) fetch failed: ${res.status}`);
  const data = await res.json<{ tracks: any[] }>();
  return data.tracks;
}
```

- [ ] **Step 4: Write `src/db/seed.ts`**

```typescript
import { getClientCredentialsToken, searchArtistsByGenre, fetchArtistTopTracks } from '../lib/spotify';

export const SEED_GENRES = [
  'pop', 'hip-hop', 'indie', 'r-n-b', 'country', 'electronic',
  'latin', 'rock', 'k-pop', 'jazz', 'classical', 'reggaeton',
];

const ARTISTS_PER_GENRE = 5;
const TRACKS_PER_ARTIST = 2;

export async function seedCatalog(env: Env): Promise<{ artistsInserted: number; tracksInserted: number }> {
  const token = await getClientCredentialsToken(env);
  const seen = new Set<string>();
  let artistsInserted = 0;
  let tracksInserted = 0;
  const now = Date.now();

  for (const genre of SEED_GENRES) {
    const artists = await searchArtistsByGenre(token, genre, ARTISTS_PER_GENRE);
    for (const artist of artists) {
      if (seen.has(artist.id)) continue;
      seen.add(artist.id);

      await env.DB.prepare(
        `INSERT OR IGNORE INTO artists (id, name, genres, image_url, popularity, source, added_by_user_id, approved, created_at)
         VALUES (?, ?, ?, ?, ?, 'seed', NULL, 1, ?)`
      ).bind(artist.id, artist.name, JSON.stringify(artist.genres ?? []), artist.images?.[0]?.url ?? null, artist.popularity ?? null, now).run();
      artistsInserted += 1;

      const tracks = await fetchArtistTopTracks(token, artist.id);
      for (const track of tracks.slice(0, TRACKS_PER_ARTIST)) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO tracks (id, name, artist_id, album_image_url, preview_url, source, added_by_user_id, approved, created_at)
           VALUES (?, ?, ?, ?, ?, 'seed', NULL, 1, ?)`
        ).bind(track.id, track.name, artist.id, track.album?.images?.[0]?.url ?? null, track.preview_url ?? null, now).run();
        tracksInserted += 1;
      }
    }
  }

  return { artistsInserted, tracksInserted };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/db/seed.test.ts`
Expected: PASS (2/2)

- [ ] **Step 6: Write the failing test for the admin seed route**

```typescript
// test/routes/admin.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

describe('POST /internal/seed', () => {
  it('rejects requests without the correct seed secret', async () => {
    const req = new Request('http://localhost/internal/seed', { method: 'POST' });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('runs the seed and returns counts when the secret matches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
        if (url.includes('/v1/search')) return new Response(JSON.stringify({ artists: { items: [] } }), { status: 200 });
        throw new Error(`unexpected ${url}`);
      })
    );
    const req = new Request('http://localhost/internal/seed', {
      method: 'POST',
      headers: { 'X-Seed-Secret': env.SEED_SECRET },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.artistsInserted).toBe(0);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 7: Add `SEED_SECRET` to the test environment**

In `wrangler.toml`, under `[env.test]`, add:

```toml
[env.test.vars]
SEED_SECRET = "test-seed-secret"
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npx vitest run test/routes/admin.test.ts`
Expected: FAIL — `/internal/seed` not registered.

- [ ] **Step 9: Write `src/routes/admin.ts`**

```typescript
import type { RouterType } from 'itty-router';
import { seedCatalog } from '../db/seed';

export function registerAdminRoutes(router: RouterType) {
  router.post('/internal/seed', async (request: Request, env: Env) => {
    if (request.headers.get('X-Seed-Secret') !== env.SEED_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    const result = await seedCatalog(env);
    return Response.json(result);
  });
}
```

- [ ] **Step 10: Register route in `src/index.ts`**

```typescript
import { registerAdminRoutes } from './routes/admin';
// ...
registerAdminRoutes(router);
```

- [ ] **Step 11: Run test to verify it passes**

Run: `npx vitest run test/routes/admin.test.ts`
Expected: PASS (2/2)

- [ ] **Step 12: Commit**

```bash
git add src/lib/spotify.ts src/db/seed.ts src/routes/admin.ts src/index.ts wrangler.toml test/db/seed.test.ts test/routes/admin.test.ts
git commit -m "feat: add catalog seed script and protected /internal/seed route"
```

---

### Task 6: Onboarding API with hard 18+ age gate

**Files:**
- Create: `src/lib/age.ts`
- Create: `src/routes/onboarding.ts`
- Modify: `src/index.ts` (register onboarding route)
- Test: `test/lib/age.test.ts`
- Test: `test/routes/onboarding.test.ts`

**Interfaces:**
- Consumes: `getSessionUser` (Task 2).
- Produces: `computeAge(dateOfBirth: string, nowMs: number): number` from `src/lib/age.ts` — pure function, later usable anywhere age needs recomputation.
- Produces: `POST /api/onboarding` accepting `{ bio?: string; date_of_birth: string; location_label: string; lat: number; lng: number; max_distance_km?: number }`, setting `users.onboarded_at` and `users.age_verified_at` on success, returning 403 with `{ error: 'underage' }` if computed age < 18 (no row is written in that case).

- [ ] **Step 1: Write the failing test for computeAge**

```typescript
// test/lib/age.test.ts
import { describe, it, expect } from 'vitest';
import { computeAge } from '../../src/lib/age';

describe('computeAge', () => {
  it('computes full years elapsed when birthday has already passed this year', () => {
    const dob = '2000-01-15';
    const now = new Date('2026-06-01').getTime();
    expect(computeAge(dob, now)).toBe(26);
  });

  it('does not count the current year if the birthday has not occurred yet', () => {
    const dob = '2000-12-31';
    const now = new Date('2026-06-01').getTime();
    expect(computeAge(dob, now)).toBe(25);
  });

  it('returns exactly 18 on the 18th birthday itself', () => {
    const dob = '2008-06-01';
    const now = new Date('2026-06-01').getTime();
    expect(computeAge(dob, now)).toBe(18);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/age.test.ts`
Expected: FAIL — `src/lib/age.ts` does not exist.

- [ ] **Step 3: Write `src/lib/age.ts`**

```typescript
export function computeAge(dateOfBirth: string, nowMs: number): number {
  const dob = new Date(dateOfBirth);
  const now = new Date(nowMs);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  const dayDiff = now.getUTCDate() - dob.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age -= 1;
  }
  return age;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/age.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Write the failing test for `/api/onboarding`**

```typescript
// test/routes/onboarding.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM users;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
});

async function sessionCookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

describe('POST /api/onboarding', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/onboarding', { method: 'POST' }), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('rejects and writes nothing when the user is under 18', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_of_birth: '2015-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.error).toBe('underage');
    const row = await env.DB.prepare('SELECT onboarded_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).toBeNull();
  });

  it('saves onboarding fields and marks age-verified for an adult', async () => {
    const cookie = await sessionCookieFor('u1');
    const req = new Request('http://localhost/api/onboarding', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bio: 'hi', date_of_birth: '1995-01-01', location_label: 'Austin, TX', lat: 30.27, lng: -97.74, max_distance_km: 40 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.onboarded_at).not.toBeNull();
    expect(row.age_verified_at).not.toBeNull();
    expect(row.bio).toBe('hi');
    expect(row.max_distance_km).toBe(40);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/routes/onboarding.test.ts`
Expected: FAIL — `/api/onboarding` not registered.

- [ ] **Step 7: Write `src/routes/onboarding.ts`**

```typescript
import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { computeAge } from '../lib/age';

interface OnboardingBody {
  bio?: string;
  date_of_birth: string;
  location_label: string;
  lat: number;
  lng: number;
  max_distance_km?: number;
}

export function registerOnboardingRoutes(router: RouterType) {
  router.post('/api/onboarding', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const body = await request.json<OnboardingBody>();
    const age = computeAge(body.date_of_birth, Date.now());
    if (age < 18) {
      return Response.json({ error: 'underage' }, { status: 403 });
    }

    const now = Date.now();
    await env.DB.prepare(
      `UPDATE users SET bio = ?, date_of_birth = ?, age_verified_at = ?, location_label = ?, lat = ?, lng = ?,
        max_distance_km = COALESCE(?, max_distance_km), onboarded_at = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      body.bio ?? null,
      body.date_of_birth,
      now,
      body.location_label,
      body.lat,
      body.lng,
      body.max_distance_km ?? null,
      now,
      now,
      user.id
    ).run();

    return Response.json({ ok: true });
  });
}
```

- [ ] **Step 8: Register route in `src/index.ts`**

```typescript
import { registerOnboardingRoutes } from './routes/onboarding';
// ...
registerOnboardingRoutes(router);
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/routes/onboarding.test.ts`
Expected: PASS (3/3)

- [ ] **Step 10: Commit**

```bash
git add src/lib/age.ts src/routes/onboarding.ts src/index.ts test/lib/age.test.ts test/routes/onboarding.test.ts
git commit -m "feat: add onboarding endpoint with hard 18+ age gate"
```

---

### Task 7: Photo upload, serving, and delete via R2

**Files:**
- Create: `src/lib/r2.ts`
- Create: `src/routes/photos.ts`
- Modify: `src/index.ts` (register photo routes)
- Test: `test/lib/r2.test.ts`
- Test: `test/routes/photos.test.ts`

**Interfaces:**
- Consumes: `getSessionUser` (Task 2).
- Produces: `createPresignedUploadUrl(env: Env, key: string, contentType: string, expiresInSeconds: number): Promise<string>` from `src/lib/r2.ts`, using R2's S3-compatible API (AWS SigV4), so photo bytes never pass through the Worker on upload.
- Produces: `POST /api/photos` accepting `{ contentType: string; sizeBytes: number }`, validating type/size server-side, returning `{ photoId: string; uploadUrl: string; r2Key: string }`. `DELETE /api/photos/:id` removes the `user_photos` row and the R2 object. `GET /photos/:id` streams the photo back (auth required, any logged-in user — profile photos are meant to be visible to swipe candidates) with the correct `Content-Type`, 404 if the photo row doesn't exist. This is the endpoint later tasks (Task 11's `primaryPhotoUrl`, Task 16/17's `<img>` tags) point at — a bare R2 key is never returned to a client.
- Global Constraint addition: new Worker Secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` for S3-compatible presigning (distinct from the `PHOTOS` binding used for server-side reads/deletes).

- [ ] **Step 1: Write the failing test for the presign helper**

```typescript
// test/lib/r2.test.ts
import { describe, it, expect } from 'vitest';
import { createPresignedUploadUrl } from '../../src/lib/r2';

const env = {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'secretkey',
  R2_BUCKET_NAME: 'wavelengthz-photos',
} as any;

describe('createPresignedUploadUrl', () => {
  it('returns a URL against the R2 S3 endpoint with SigV4 query params', async () => {
    const url = new URL(await createPresignedUploadUrl(env, 'users/u1/photo-1.jpg', 'image/jpeg', 300));
    expect(url.hostname).toBe('acct123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/wavelengthz-photos/users/u1/photo-1.jpg');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-Credential')).toContain('AKIDEXAMPLE');
  });

  it('produces a different signature for a different key', async () => {
    const urlA = await createPresignedUploadUrl(env, 'a.jpg', 'image/jpeg', 300);
    const urlB = await createPresignedUploadUrl(env, 'b.jpg', 'image/jpeg', 300);
    expect(new URL(urlA).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(urlB).searchParams.get('X-Amz-Signature')
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/r2.test.ts`
Expected: FAIL — `src/lib/r2.ts` does not exist.

- [ ] **Step 3: Write `src/lib/r2.ts`**

```typescript
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function amzDate(now: Date): { date: string; dateTime: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { date: iso.slice(0, 8), dateTime: iso };
}

export async function createPresignedUploadUrl(
  env: Env,
  key: string,
  contentType: string,
  expiresInSeconds: number
): Promise<string> {
  const region = 'auto';
  const service = 's3';
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const { date, dateTime } = amzDate(new Date());
  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const credential = `${env.R2_ACCESS_KEY_ID}/${credentialScope}`;

  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': dateTime,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  });
  query.sort();

  const canonicalRequest = [
    'PUT',
    `/${env.R2_BUCKET_NAME}/${key}`,
    query.toString(),
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateTime,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(new TextEncoder().encode('AWS4' + env.R2_SECRET_ACCESS_KEY), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  query.set('X-Amz-Signature', signature);

  return `https://${host}/${env.R2_BUCKET_NAME}/${key}?${query.toString()}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/r2.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Write the failing test for photo routes**

```typescript
// test/routes/photos.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM user_photos;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

describe('POST /api/photos', () => {
  it('rejects an unsupported content type', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/photos', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/gif', sizeBytes: 1000 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it('rejects a file over the size limit', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/photos', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 20 * 1024 * 1024 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it('returns a signed upload URL and creates a photo row', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/photos', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 1000 }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.uploadUrl).toContain('X-Amz-Signature');
    const row = await env.DB.prepare('SELECT * FROM user_photos WHERE id = ?').bind(body.photoId).first<any>();
    expect(row.user_id).toBe('u1');
    expect(row.position).toBe(0);
  });
});

describe('DELETE /api/photos/:id', () => {
  it('removes the photo row', async () => {
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u1', 'users/u1/p1.jpg', 0, 1000)`
    ).run();
    const req = new Request('http://localhost/api/photos/p1', { method: 'DELETE', headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM user_photos WHERE id = ?').bind('p1').first();
    expect(row).toBeNull();
  });
});

describe('GET /photos/:id', () => {
  it('streams the photo bytes with the stored content type', async () => {
    const cookie = await cookieFor('u1');
    await env.PHOTOS.put('users/u1/p1.jpg', new Blob(['fake-jpeg-bytes']), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u1', 'users/u1/p1.jpg', 0, 1000)`
    ).run();

    const req = new Request('http://localhost/photos/p1', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(await res.text()).toBe('fake-jpeg-bytes');
  });

  it('returns 404 for an unknown photo id', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/photos/does-not-exist', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/routes/photos.test.ts`
Expected: FAIL — photo routes not registered.

- [ ] **Step 7: Write `src/routes/photos.ts`**

```typescript
import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { createPresignedUploadUrl } from '../lib/r2';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024;

export function registerPhotoRoutes(router: RouterType) {
  router.post('/api/photos', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { contentType, sizeBytes } = await request.json<{ contentType: string; sizeBytes: number }>();
    if (!ALLOWED_TYPES.has(contentType)) {
      return Response.json({ error: 'unsupported_type' }, { status: 400 });
    }
    if (sizeBytes > MAX_BYTES) {
      return Response.json({ error: 'file_too_large' }, { status: 400 });
    }

    const countRow = await env.DB.prepare('SELECT COUNT(*) as c FROM user_photos WHERE user_id = ?')
      .bind(user.id)
      .first<{ c: number }>();
    const position = countRow?.c ?? 0;

    const photoId = crypto.randomUUID();
    const ext = contentType.split('/')[1];
    const r2Key = `users/${user.id}/${photoId}.${ext}`;

    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(photoId, user.id, r2Key, position, Date.now()).run();

    const uploadUrl = await createPresignedUploadUrl(env, r2Key, contentType, 300);

    return Response.json({ photoId, uploadUrl, r2Key });
  });

  router.delete('/api/photos/:id', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const photo = await env.DB.prepare('SELECT * FROM user_photos WHERE id = ? AND user_id = ?')
      .bind(request.params.id, user.id)
      .first<{ r2_key: string }>();
    if (!photo) return new Response('Not found', { status: 404 });

    await env.PHOTOS.delete(photo.r2_key);
    await env.DB.prepare('DELETE FROM user_photos WHERE id = ?').bind(request.params.id).run();

    return Response.json({ ok: true });
  });

  router.get('/photos/:id', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const photo = await env.DB.prepare('SELECT r2_key FROM user_photos WHERE id = ?')
      .bind(request.params.id)
      .first<{ r2_key: string }>();
    if (!photo) return new Response('Not found', { status: 404 });

    const object = await env.PHOTOS.get(photo.r2_key);
    if (!object) return new Response('Not found', { status: 404 });

    return new Response(object.body, {
      headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream' },
    });
  });
}
```

- [ ] **Step 8: Register routes in `src/index.ts`**

```typescript
import { registerPhotoRoutes } from './routes/photos';
// ...
registerPhotoRoutes(router);
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/routes/photos.test.ts`
Expected: PASS (6/6)

- [ ] **Step 10: Commit**

```bash
git add src/lib/r2.ts src/routes/photos.ts src/index.ts test/lib/r2.test.ts test/routes/photos.test.ts
git commit -m "feat: add signed R2 photo upload, serving, and delete endpoints"
```

---

### Task 8: Match scoring library (haversine, overlap, blended score)

**Files:**
- Create: `src/lib/scoring.ts`
- Test: `test/lib/scoring.test.ts`

**Interfaces:**
- Produces (all pure functions, no DB/network access — later tasks supply DB-derived inputs):
  - `haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number`
  - `proximityScore(distanceKm: number, maxDistanceKm: number): number` — 0 if `distanceKm > maxDistanceKm`, else `1 - distanceKm / maxDistanceKm`
  - `bucketedDistanceLabel(distanceKm: number): string` — e.g. `"3 miles away"`, `"<1 mile away"` — the ONLY distance value ever sent to a client (never raw lat/lng)
  - `weightedOverlap(a: Array<{ id: string; rank: number }>, b: Array<{ id: string; rank: number }>): number` — rank-weighted Jaccard, weight `1/rank`, in `[0,1]`
  - `jaccard(a: Set<string>, b: Set<string>): number` — plain Jaccard, in `[0,1]`
  - `spotifyOverlap(profileA: MusicProfile, profileB: MusicProfile): number` — average of artist weighted-overlap and genre weighted-overlap
  - `computeBlendedScore(input: BlendedScoreInput): number` implementing docs/PLAN.md §7's formula: `0.35*spotifyOverlap + 0.30*musicSwipeOverlap + 0.15*mutualInterestBoost + 0.20*proximityScore`
  - `MusicProfile` type `{ topArtists: Array<{ id: string; rank: number }>; topGenres: string[] }` and `BlendedScoreInput` type `{ spotifyOverlap: number; musicSwipeOverlap: number; mutualInterestBoost: number; proximityScore: number }`
- Design note (resolves an ambiguity in docs/PLAN.md §7): `mutualInterestBoost` is `1` if the **candidate has already swiped right on the current user** (i.e. they like you first — the same signal that drives the like-priority queue in §7.1), else `0`. It is not "both already matched," since a matched pair no longer appears as a scoring candidate. Task 11 computes this boolean via a DB query and passes it in as a plain `0 | 1`.

- [ ] **Step 1: Write the failing tests for the scoring library**

```typescript
// test/lib/scoring.test.ts
import { describe, it, expect } from 'vitest';
import {
  haversineKm,
  proximityScore,
  bucketedDistanceLabel,
  weightedOverlap,
  jaccard,
  spotifyOverlap,
  computeBlendedScore,
} from '../../src/lib/scoring';

describe('haversineKm', () => {
  it('returns ~0 for identical coordinates', () => {
    expect(haversineKm(30.27, -97.74, 30.27, -97.74)).toBeCloseTo(0, 3);
  });

  it('computes a known distance between Austin and Dallas (~300km) within 5%', () => {
    const km = haversineKm(30.2672, -97.7431, 32.7767, -96.797);
    expect(km).toBeGreaterThan(280);
    expect(km).toBeLessThan(320);
  });
});

describe('proximityScore', () => {
  it('is 1 at zero distance', () => {
    expect(proximityScore(0, 80)).toBe(1);
  });
  it('is 0 beyond max distance', () => {
    expect(proximityScore(81, 80)).toBe(0);
  });
  it('decreases linearly within range', () => {
    expect(proximityScore(40, 80)).toBeCloseTo(0.5, 5);
  });
});

describe('bucketedDistanceLabel', () => {
  it('renders sub-mile distances distinctly', () => {
    expect(bucketedDistanceLabel(0.5)).toBe('<1 mile away');
  });
  it('renders whole-mile distances', () => {
    expect(bucketedDistanceLabel(19.31)).toBe('12 miles away'); // ~19.31km = 12mi
  });
});

describe('weightedOverlap', () => {
  it('is 1.0 for identical rank-ordered lists', () => {
    const list = [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }];
    expect(weightedOverlap(list, list)).toBeCloseTo(1, 5);
  });
  it('is 0 for disjoint lists', () => {
    expect(weightedOverlap([{ id: 'a', rank: 1 }], [{ id: 'z', rank: 1 }])).toBe(0);
  });
  it('weights a shared top-ranked item higher than a shared low-ranked one', () => {
    const sharedTop = weightedOverlap([{ id: 'a', rank: 1 }, { id: 'x', rank: 2 }], [{ id: 'a', rank: 1 }, { id: 'y', rank: 2 }]);
    const sharedLow = weightedOverlap([{ id: 'a', rank: 2 }, { id: 'x', rank: 1 }], [{ id: 'a', rank: 2 }, { id: 'y', rank: 1 }]);
    expect(sharedTop).toBeGreaterThan(sharedLow);
  });
});

describe('jaccard', () => {
  it('is 1.0 for identical sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });
  it('is 0.5 for a half-overlapping pair', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'c']))).toBeCloseTo(1 / 3, 5);
  });
  it('is 0 for two empty sets', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe('spotifyOverlap', () => {
  it('averages artist and genre overlap', () => {
    const a = { topArtists: [{ id: 'a1', rank: 1 }], topGenres: ['pop', 'rock'] };
    const b = { topArtists: [{ id: 'a1', rank: 1 }], topGenres: ['pop'] };
    const score = spotifyOverlap(a, b);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('computeBlendedScore', () => {
  it('applies the documented weights', () => {
    const score = computeBlendedScore({
      spotifyOverlap: 1,
      musicSwipeOverlap: 1,
      mutualInterestBoost: 1,
      proximityScore: 1,
    });
    expect(score).toBeCloseTo(1, 5);
  });

  it('is 0 when every input is 0', () => {
    expect(
      computeBlendedScore({ spotifyOverlap: 0, musicSwipeOverlap: 0, mutualInterestBoost: 0, proximityScore: 0 })
    ).toBe(0);
  });

  it('weights spotifyOverlap most heavily among the four inputs', () => {
    const onlySpotify = computeBlendedScore({ spotifyOverlap: 1, musicSwipeOverlap: 0, mutualInterestBoost: 0, proximityScore: 0 });
    const onlyProximity = computeBlendedScore({ spotifyOverlap: 0, musicSwipeOverlap: 0, mutualInterestBoost: 0, proximityScore: 1 });
    expect(onlySpotify).toBeGreaterThan(onlyProximity);
    expect(onlySpotify).toBeCloseTo(0.35, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/scoring.test.ts`
Expected: FAIL — `src/lib/scoring.ts` does not exist.

- [ ] **Step 3: Write `src/lib/scoring.ts`**

```typescript
export interface MusicProfile {
  topArtists: Array<{ id: string; rank: number }>;
  topGenres: string[];
}

export interface BlendedScoreInput {
  spotifyOverlap: number;
  musicSwipeOverlap: number;
  mutualInterestBoost: number;
  proximityScore: number;
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function proximityScore(distanceKm: number, maxDistanceKm: number): number {
  if (distanceKm > maxDistanceKm) return 0;
  if (maxDistanceKm === 0) return distanceKm === 0 ? 1 : 0;
  return 1 - distanceKm / maxDistanceKm;
}

export function bucketedDistanceLabel(distanceKm: number): string {
  const miles = distanceKm * 0.621371;
  if (miles < 1) return '<1 mile away';
  return `${Math.round(miles)} miles away`;
}

function rankWeights(items: Array<{ id: string; rank: number }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(item.id, 1 / item.rank);
  return map;
}

export function weightedOverlap(
  a: Array<{ id: string; rank: number }>,
  b: Array<{ id: string; rank: number }>
): number {
  const wa = rankWeights(a);
  const wb = rankWeights(b);
  const ids = new Set([...wa.keys(), ...wb.keys()]);
  let numerator = 0;
  let denominator = 0;
  for (const id of ids) {
    const va = wa.get(id) ?? 0;
    const vb = wb.get(id) ?? 0;
    numerator += Math.min(va, vb);
    denominator += Math.max(va, vb);
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function spotifyOverlap(a: MusicProfile, b: MusicProfile): number {
  const artistScore = weightedOverlap(a.topArtists, b.topArtists);
  const genreScore = jaccard(new Set(a.topGenres), new Set(b.topGenres));
  return (artistScore + genreScore) / 2;
}

export function computeBlendedScore(input: BlendedScoreInput): number {
  return (
    0.35 * input.spotifyOverlap +
    0.3 * input.musicSwipeOverlap +
    0.15 * input.mutualInterestBoost +
    0.2 * input.proximityScore
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/scoring.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/lib/scoring.ts test/lib/scoring.test.ts
git commit -m "feat: add pure match-scoring library (haversine, overlap, blended score)"
```

---

### Task 9: Catalog search-and-add (artists + tracks)

**Files:**
- Modify: `src/lib/spotify.ts` (add name-scoped search helpers)
- Create: `src/routes/catalog.ts`
- Modify: `src/index.ts` (register catalog routes)
- Test: `test/routes/catalog.test.ts`

**Interfaces:**
- Consumes: `getSessionUser` (Task 2), `getValidAccessToken` (Task 4).
- Produces: `searchArtistsByName(token: string, query: string, limit: number)` and `searchTracksByArtist(token: string, artistName: string, trackQuery: string, limit: number)`, added to `src/lib/spotify.ts`.
- Produces: `GET /api/artists/search?q=` (returns local matches merged with live Spotify matches, each tagged `inCatalog: boolean`), `POST /api/artists` (`{ spotifyArtistId }`, inserts with `source='spotify_search'`, `approved=1`, `added_by_user_id=<current user>`), `GET /api/tracks/search?q=&artist_id=`, `POST /api/tracks` (`{ spotifyTrackId, artistId }`), all requiring auth.

- [ ] **Step 1: Write the failing test for catalog routes**

```typescript
// test/routes/catalog.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM artists; DELETE FROM tracks;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('local-1', 'Local Artist', '["pop"]', 'seed', 1, 1000)`
  ).run();
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

function stubSpotify() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      if (url.includes('/v1/search') && url.includes('type=artist')) {
        return new Response(
          JSON.stringify({ artists: { items: [{ id: 'new-artist', name: 'New Artist', genres: ['indie'], images: [], popularity: 50 }] } }),
          { status: 200 }
        );
      }
      if (url.includes('/v1/artists/new-artist')) {
        return new Response(JSON.stringify({ id: 'new-artist', name: 'New Artist', genres: ['indie'], images: [], popularity: 50 }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    })
  );
}

describe('GET /api/artists/search', () => {
  it('returns local matches merged with live Spotify results, tagged by catalog membership', async () => {
    stubSpotify();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/artists/search?q=art', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    const local = body.results.find((r: any) => r.id === 'local-1');
    const fresh = body.results.find((r: any) => r.id === 'new-artist');
    expect(local.inCatalog).toBe(true);
    expect(fresh.inCatalog).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('POST /api/artists', () => {
  it('validates against Spotify and inserts with source spotify_search', async () => {
    stubSpotify();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/artists', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyArtistId: 'new-artist' }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind('new-artist').first<any>();
    expect(row.source).toBe('spotify_search');
    expect(row.approved).toBe(1);
    expect(row.added_by_user_id).toBe('u1');
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/catalog.test.ts`
Expected: FAIL — catalog routes not registered.

- [ ] **Step 3: Add name-scoped search helpers to `src/lib/spotify.ts`**

Append to the existing file:

```typescript
export async function searchArtistsByName(token: string, query: string, limit: number) {
  const res = await fetch(
    `https://api.spotify.com/v1/search?type=artist&limit=${limit}&q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Spotify artist search failed: ${res.status}`);
  const data = await res.json<{ artists: { items: any[] } }>();
  return data.artists.items;
}

export async function fetchArtistById(token: string, artistId: string) {
  const res = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify artist fetch failed: ${res.status}`);
  return res.json<any>();
}

export async function searchTracksByArtist(token: string, artistName: string, trackQuery: string, limit: number) {
  const q = `artist:${artistName} track:${trackQuery}`;
  const res = await fetch(
    `https://api.spotify.com/v1/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Spotify track search failed: ${res.status}`);
  const data = await res.json<{ tracks: { items: any[] } }>();
  return data.tracks.items;
}

export async function fetchTrackById(token: string, trackId: string) {
  const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify track fetch failed: ${res.status}`);
  return res.json<any>();
}
```

- [ ] **Step 4: Write `src/routes/catalog.ts`**

```typescript
import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { getValidAccessToken } from '../lib/tokens';
import { searchArtistsByName, fetchArtistById, searchTracksByArtist, fetchTrackById, getClientCredentialsToken } from '../lib/spotify';

export function registerCatalogRoutes(router: RouterType) {
  router.get('/api/artists/search', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const q = new URL(request.url).searchParams.get('q') ?? '';
    const localRows = await env.DB.prepare('SELECT * FROM artists WHERE name LIKE ? LIMIT 20')
      .bind(`%${q}%`)
      .all<any>();
    const localIds = new Set(localRows.results.map((r) => r.id));

    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
    const spotifyResults = q ? await searchArtistsByName(token, q, 10) : [];

    const merged = [
      ...localRows.results.map((r) => ({ id: r.id, name: r.name, genres: JSON.parse(r.genres), inCatalog: true })),
      ...spotifyResults
        .filter((a: any) => !localIds.has(a.id))
        .map((a: any) => ({ id: a.id, name: a.name, genres: a.genres ?? [], inCatalog: false })),
    ];

    return Response.json({ results: merged });
  });

  router.post('/api/artists', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { spotifyArtistId } = await request.json<{ spotifyArtistId: string }>();
    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
    const artist = await fetchArtistById(token, spotifyArtistId);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO artists (id, name, genres, image_url, popularity, source, added_by_user_id, approved, created_at)
       VALUES (?, ?, ?, ?, ?, 'spotify_search', ?, 1, ?)`
    ).bind(artist.id, artist.name, JSON.stringify(artist.genres ?? []), artist.images?.[0]?.url ?? null, artist.popularity ?? null, user.id, Date.now()).run();

    return Response.json({ ok: true, artistId: artist.id });
  });

  router.get('/api/tracks/search', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const q = url.searchParams.get('q') ?? '';
    const artistId = url.searchParams.get('artist_id');
    if (!artistId) return Response.json({ error: 'artist_id required' }, { status: 400 });

    const artist = await env.DB.prepare('SELECT name FROM artists WHERE id = ?').bind(artistId).first<{ name: string }>();
    if (!artist) return Response.json({ error: 'unknown artist_id' }, { status: 400 });

    const localRows = await env.DB.prepare('SELECT * FROM tracks WHERE artist_id = ? AND name LIKE ? LIMIT 20')
      .bind(artistId, `%${q}%`)
      .all<any>();
    const localIds = new Set(localRows.results.map((r) => r.id));

    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
    const spotifyResults = q ? await searchTracksByArtist(token, artist.name, q, 10) : [];

    const merged = [
      ...localRows.results.map((r) => ({ id: r.id, name: r.name, inCatalog: true })),
      ...spotifyResults.filter((t: any) => !localIds.has(t.id)).map((t: any) => ({ id: t.id, name: t.name, inCatalog: false })),
    ];

    return Response.json({ results: merged });
  });

  router.post('/api/tracks', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { spotifyTrackId, artistId } = await request.json<{ spotifyTrackId: string; artistId: string }>();
    const token = await getValidAccessToken(user, env, env.DB).catch(() => getClientCredentialsToken(env));
    const track = await fetchTrackById(token, spotifyTrackId);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO tracks (id, name, artist_id, album_image_url, preview_url, source, added_by_user_id, approved, created_at)
       VALUES (?, ?, ?, ?, ?, 'spotify_search', ?, 1, ?)`
    ).bind(track.id, track.name, artistId, track.album?.images?.[0]?.url ?? null, track.preview_url ?? null, user.id, Date.now()).run();

    return Response.json({ ok: true, trackId: track.id });
  });
}
```

- [ ] **Step 5: Register routes in `src/index.ts`**

```typescript
import { registerCatalogRoutes } from './routes/catalog';
// ...
registerCatalogRoutes(router);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/routes/catalog.test.ts`
Expected: PASS (2/2)

- [ ] **Step 7: Commit**

```bash
git add src/lib/spotify.ts src/routes/catalog.ts src/index.ts test/routes/catalog.test.ts
git commit -m "feat: add catalog search-and-add endpoints for artists and tracks"
```

---

### Task 10: Music-mode swipe deck (candidates, swipe, history)

**Files:**
- Create: `src/routes/musicSwipes.ts`
- Modify: `src/index.ts` (register music-swipe routes)
- Test: `test/routes/musicSwipes.test.ts`

**Interfaces:**
- Consumes: `getSessionUser` (Task 2).
- Produces: `GET /api/candidates/music?item_type=artist|track&limit=` (excludes items already swiped by the current user, defaults `item_type=artist`, `limit=10`), `POST /api/swipe/music` (`{ item_type, item_id, direction }`, upserts via the `UNIQUE(user_id, item_type, item_id)` constraint), `GET /api/swipes/music?limit=&offset=` (history, newest first, joined with artist/track name), `PATCH /api/swipes/music/:id` (`{ direction }`, updates an existing swipe row the caller owns).

- [ ] **Step 1: Write the failing test for music-swipe routes**

```typescript
// test/routes/musicSwipes.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM artists; DELETE FROM music_swipes;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(`INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('a1', 'Artist One', '[]', 'seed', 1, 1000)`).run();
  await env.DB.prepare(`INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('a2', 'Artist Two', '[]', 'seed', 1, 1000)`).run();
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

describe('GET /api/candidates/music', () => {
  it('excludes artists the user has already swiped on', async () => {
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'right', 1000, 1000)`
    ).run();
    const req = new Request('http://localhost/api/candidates/music', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates.map((c: any) => c.itemId)).toEqual(['a2']);
  });
});

describe('POST /api/swipe/music', () => {
  it('creates a swipe and upserts direction on repeat swipe', async () => {
    const cookie = await cookieFor('u1');
    const swipe = (direction: string) =>
      worker.fetch(
        new Request('http://localhost/api/swipe/music', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_type: 'artist', item_id: 'a1', direction }),
        }),
        env,
        {} as ExecutionContext
      );

    await swipe('left');
    let row = await env.DB.prepare('SELECT * FROM music_swipes WHERE user_id = ? AND item_id = ?').bind('u1', 'a1').first<any>();
    expect(row.direction).toBe('left');

    await swipe('right');
    const rows = await env.DB.prepare('SELECT * FROM music_swipes WHERE user_id = ? AND item_id = ?').bind('u1', 'a1').all<any>();
    expect(rows.results.length).toBe(1); // upsert, not a second row
    expect(rows.results[0].direction).toBe('right');
  });
});

describe('GET /api/swipes/music and PATCH', () => {
  it('lists history and allows changing a past decision', async () => {
    const cookie = await cookieFor('u1');
    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'artist', 'a1', 'left', 1000, 1000)`
    ).run();

    const historyRes = await worker.fetch(new Request('http://localhost/api/swipes/music', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const history = await historyRes.json<any>();
    expect(history.swipes[0].direction).toBe('left');
    expect(history.swipes[0].name).toBe('Artist One');

    const patchRes = await worker.fetch(
      new Request('http://localhost/api/swipes/music/s1', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(patchRes.status).toBe(200);
    const row = await env.DB.prepare('SELECT direction FROM music_swipes WHERE id = ?').bind('s1').first<any>();
    expect(row.direction).toBe('right');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/musicSwipes.test.ts`
Expected: FAIL — music-swipe routes not registered.

- [ ] **Step 3: Write `src/routes/musicSwipes.ts`**

```typescript
import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';

export function registerMusicSwipeRoutes(router: RouterType) {
  router.get('/api/candidates/music', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const itemType = url.searchParams.get('item_type') ?? 'artist';
    const limit = Number(url.searchParams.get('limit') ?? '10');
    const table = itemType === 'track' ? 'tracks' : 'artists';

    const rows = await env.DB.prepare(
      `SELECT id, name FROM ${table}
       WHERE approved = 1 AND id NOT IN (
         SELECT item_id FROM music_swipes WHERE user_id = ? AND item_type = ?
       )
       ORDER BY created_at ASC
       LIMIT ?`
    ).bind(user.id, itemType, limit).all<{ id: string; name: string }>();

    return Response.json({
      candidates: rows.results.map((r) => ({ itemType, itemId: r.id, name: r.name })),
    });
  });

  router.post('/api/swipe/music', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { item_type, item_id, direction } = await request.json<{
      item_type: 'artist' | 'track';
      item_id: string;
      direction: 'left' | 'right';
    }>();
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO music_swipes (id, user_id, item_type, item_id, direction, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET direction = excluded.direction, updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), user.id, item_type, item_id, direction, now, now).run();

    return Response.json({ ok: true });
  });

  router.get('/api/swipes/music', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const offset = Number(url.searchParams.get('offset') ?? '0');

    const rows = await env.DB.prepare(
      `SELECT ms.id, ms.item_type, ms.item_id, ms.direction, ms.created_at,
              COALESCE(a.name, t.name) as name
       FROM music_swipes ms
       LEFT JOIN artists a ON ms.item_type = 'artist' AND a.id = ms.item_id
       LEFT JOIN tracks t ON ms.item_type = 'track' AND t.id = ms.item_id
       WHERE ms.user_id = ?
       ORDER BY ms.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(user.id, limit, offset).all<any>();

    return Response.json({ swipes: rows.results });
  });

  router.patch('/api/swipes/music/:id', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { direction } = await request.json<{ direction: 'left' | 'right' }>();
    const result = await env.DB.prepare(
      `UPDATE music_swipes SET direction = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    ).bind(direction, Date.now(), request.params.id, user.id).run();

    if (result.meta.changes === 0) return new Response('Not found', { status: 404 });
    return Response.json({ ok: true });
  });
}
```

- [ ] **Step 4: Register routes in `src/index.ts`**

```typescript
import { registerMusicSwipeRoutes } from './routes/musicSwipes';
// ...
registerMusicSwipeRoutes(router);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/routes/musicSwipes.test.ts`
Expected: PASS (3/3)

- [ ] **Step 6: Commit**

```bash
git add src/routes/musicSwipes.ts src/index.ts test/routes/musicSwipes.test.ts
git commit -m "feat: add music-mode swipe candidates, swipe, and history endpoints"
```

---

### Task 11: People-mode swipe deck (geo + blended scoring + like-priority queue) and match creation

**Files:**
- Create: `src/lib/profile.ts`
- Create: `src/lib/matching.ts`
- Create: `src/routes/peopleSwipes.ts`
- Modify: `src/index.ts` (register people-swipe routes)
- Test: `test/lib/matching.test.ts`
- Test: `test/routes/peopleSwipes.test.ts`

**Interfaces:**
- Consumes: `haversineKm`, `proximityScore`, `bucketedDistanceLabel`, `spotifyOverlap`, `jaccard`, `computeBlendedScore`, `MusicProfile` (Task 8); `getSessionUser`, `UserRow` (Task 2).
- Produces: `getMusicProfile(db: D1Database, userId: string): Promise<MusicProfile>` and `getRightSwipedItemIds(db: D1Database, userId: string): Promise<Set<string>>` from `src/lib/profile.ts`.
- Produces: `scoreCandidate(db: D1Database, me: UserRow, candidate: UserRow, alreadyLikedMe: boolean): Promise<{ score: number; distanceKm: number }>` and `createMatchIfMutual(db: D1Database, swiperId: string, targetId: string): Promise<{ matchId: string } | null>` from `src/lib/matching.ts`. `createMatchIfMutual` inserts a `notifications` row of `type='match'` for **both** participants (`email_sent_at` left `NULL` — Task 12 wires the actual send) whenever it creates a brand-new match; it is a no-op (returns `null`) if the swipe isn't mutual-right or the match already exists.
- Produces: `GET /api/candidates/people?limit=` — like-priority candidates first (§7.1: people who already swiped right on the caller, not yet decided, not blocked), then the scored normal pool, distance shown only as `bucketedDistanceLabel`, each candidate's `primaryPhotoUrl` set to `/photos/{id}` of their `user_photos` row with `position = 0` (`null` if they have none yet) using the serving endpoint from Task 7 — and `POST /api/swipe/people` (`{ target_id, direction }`, upserts `people_swipes` with a freshly computed `match_score`, then calls `createMatchIfMutual`).
- Produces: `GET /api/swipes/people?limit=&offset=` and `PATCH /api/swipes/people/:id` (`{ direction }`) — the people-mode equivalents of Task 10's music-swipe history/update endpoints, same upsert-history semantics, joined with the target's `display_name`.

- [ ] **Step 1: Write the failing test for `src/lib/matching.ts`**

```typescript
// test/lib/matching.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createMatchIfMutual, scoreCandidate } from '../../src/lib/matching';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function makeUser(id: string, lat: number, lng: number) {
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, lat, lng, max_distance_km, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 80, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`, lat, lng).run();
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM users; DELETE FROM people_swipes; DELETE FROM matches; DELETE FROM notifications; DELETE FROM blocks;');
  await makeUser('u1', 30.27, -97.74);
  await makeUser('u2', 30.28, -97.75);
});

describe('scoreCandidate', () => {
  it('returns a score in [0,1] and a positive distance for two nearby users', async () => {
    const me = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first<any>();
    const candidate = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u2').first<any>();
    const { score, distanceKm } = await scoreCandidate(env.DB, me, candidate, false);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(distanceKm).toBeGreaterThan(0);
  });

  it('scores higher when alreadyLikedMe is true, all else equal', async () => {
    const me = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first<any>();
    const candidate = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u2').first<any>();
    const without = await scoreCandidate(env.DB, me, candidate, false);
    const withBoost = await scoreCandidate(env.DB, me, candidate, true);
    expect(withBoost.score).toBeGreaterThan(without.score);
  });
});

describe('createMatchIfMutual', () => {
  it('does nothing on a one-directional right swipe', async () => {
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('s1', 'u1', 'u2', 'right', 1000, 1000)`
    ).run();
    const result = await createMatchIfMutual(env.DB, 'u1', 'u2');
    expect(result).toBeNull();
  });

  it('creates exactly one match row and two match notifications on mutual right swipes, regardless of id order', async () => {
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('s1', 'u2', 'u1', 'right', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('s2', 'u1', 'u2', 'right', 1000, 1000)`
    ).run();

    const result = await createMatchIfMutual(env.DB, 'u1', 'u2');
    expect(result).not.toBeNull();

    const matches = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matches.results.length).toBe(1);

    const notifications = await env.DB.prepare("SELECT * FROM notifications WHERE type = 'match'").all<any>();
    expect(notifications.results.length).toBe(2);
    expect(notifications.results.every((n: any) => n.email_sent_at === null)).toBe(true);

    const second = await createMatchIfMutual(env.DB, 'u2', 'u1');
    expect(second).toBeNull(); // already matched, no duplicate

    const matchesAfter = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matchesAfter.results.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/matching.test.ts`
Expected: FAIL — `src/lib/matching.ts` does not exist.

- [ ] **Step 3: Write `src/lib/profile.ts`**

```typescript
import type { MusicProfile } from './scoring';

export async function getMusicProfile(db: D1Database, userId: string): Promise<MusicProfile> {
  const row = await db.prepare('SELECT top_artists, top_genres FROM music_profiles WHERE user_id = ?')
    .bind(userId)
    .first<{ top_artists: string; top_genres: string }>();
  if (!row) return { topArtists: [], topGenres: [] };
  return {
    topArtists: JSON.parse(row.top_artists).map((a: any) => ({ id: a.artist_id, rank: a.rank })),
    topGenres: JSON.parse(row.top_genres),
  };
}

export async function getRightSwipedItemIds(db: D1Database, userId: string): Promise<Set<string>> {
  const rows = await db.prepare(`SELECT item_id FROM music_swipes WHERE user_id = ? AND direction = 'right'`)
    .bind(userId)
    .all<{ item_id: string }>();
  return new Set(rows.results.map((r) => r.item_id));
}
```

- [ ] **Step 4: Write `src/lib/matching.ts`**

```typescript
import type { UserRow } from './session';
import { getMusicProfile, getRightSwipedItemIds } from './profile';
import { haversineKm, proximityScore, spotifyOverlap, jaccard, computeBlendedScore } from './scoring';

export async function scoreCandidate(
  db: D1Database,
  me: UserRow,
  candidate: UserRow,
  alreadyLikedMe: boolean
): Promise<{ score: number; distanceKm: number }> {
  const [meProfile, candidateProfile, meRightSwiped, candidateRightSwiped] = await Promise.all([
    getMusicProfile(db, me.id),
    getMusicProfile(db, candidate.id),
    getRightSwipedItemIds(db, me.id),
    getRightSwipedItemIds(db, candidate.id),
  ]);

  const distanceKm = haversineKm(me.lat!, me.lng!, candidate.lat!, candidate.lng!);

  const score = computeBlendedScore({
    spotifyOverlap: spotifyOverlap(meProfile, candidateProfile),
    musicSwipeOverlap: jaccard(meRightSwiped, candidateRightSwiped),
    mutualInterestBoost: alreadyLikedMe ? 1 : 0,
    proximityScore: proximityScore(distanceKm, me.max_distance_km),
  });

  return { score, distanceKm };
}

export async function createMatchIfMutual(
  db: D1Database,
  swiperId: string,
  targetId: string
): Promise<{ matchId: string } | null> {
  const swipedRightBack = await db
    .prepare(`SELECT 1 FROM people_swipes WHERE swiper_id = ? AND target_id = ? AND direction = 'right'`)
    .bind(swiperId, targetId)
    .first();
  const swipedRightForward = await db
    .prepare(`SELECT 1 FROM people_swipes WHERE swiper_id = ? AND target_id = ? AND direction = 'right'`)
    .bind(targetId, swiperId)
    .first();

  if (!swipedRightBack || !swipedRightForward) return null;

  const [userA, userB] = [swiperId, targetId].sort();
  const matchId = crypto.randomUUID();
  const now = Date.now();

  const insertResult = await db
    .prepare(`INSERT OR IGNORE INTO matches (id, user_a_id, user_b_id, created_at) VALUES (?, ?, ?, ?)`)
    .bind(matchId, userA, userB, now)
    .run();

  if (insertResult.meta.changes === 0) return null; // match already existed

  for (const recipient of [userA, userB]) {
    await db
      .prepare(`INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES (?, ?, 'match', ?, ?)`)
      .bind(crypto.randomUUID(), recipient, matchId, now)
      .run();
  }

  return { matchId };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/lib/matching.test.ts`
Expected: PASS (4/4)

- [ ] **Step 6: Write the failing test for people-swipe routes**

```typescript
// test/routes/peopleSwipes.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function makeUser(id: string) {
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, lat, lng, max_distance_km, onboarded_at, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, 30.27, -97.74, 80, 1000, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`).run();
}

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM users; DELETE FROM people_swipes; DELETE FROM matches; DELETE FROM notifications; DELETE FROM blocks; DELETE FROM sessions;'
  );
  await makeUser('u1');
  await makeUser('u2');
  await makeUser('u3');
});

describe('GET /api/candidates/people', () => {
  it('never exposes raw lat/lng, only a distance label', async () => {
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(JSON.stringify(body)).not.toMatch(/30\.2/);
    expect(body.candidates[0].distanceLabel).toBeTruthy();
  });

  it('surfaces someone who already liked me at the front of the queue', async () => {
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('s1', 'u2', 'u1', 'right', 0.9, 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.candidates[0].id).toBe('u2');
    expect(body.candidates[0].likedYou).toBe(true);
  });

  it('sets primaryPhotoUrl from the position-0 photo, or null with no photos', async () => {
    await env.DB.prepare(
      `INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u2', 'users/u2/p1.jpg', 0, 1000)`
    ).run();
    const cookie = await cookieFor('u1');
    const req = new Request('http://localhost/api/candidates/people', { headers: { Cookie: cookie } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    const u2 = body.candidates.find((c: any) => c.id === 'u2');
    const u3 = body.candidates.find((c: any) => c.id === 'u3');
    expect(u2.primaryPhotoUrl).toBe('/photos/p1');
    expect(u3.primaryPhotoUrl).toBeNull();
  });
});

describe('POST /api/swipe/people', () => {
  it('creates a match on the second mutual right swipe', async () => {
    const cookie1 = await cookieFor('u1');
    const cookie2 = await cookieFor('u2');

    await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie1, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'u2', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );

    let matches = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matches.results.length).toBe(0);

    await worker.fetch(
      new Request('http://localhost/api/swipe/people', {
        method: 'POST',
        headers: { Cookie: cookie2, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: 'u1', direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );

    matches = await env.DB.prepare('SELECT * FROM matches').all<any>();
    expect(matches.results.length).toBe(1);

    const swipeRow = await env.DB.prepare('SELECT match_score FROM people_swipes WHERE swiper_id = ? AND target_id = ?').bind('u1', 'u2').first<any>();
    expect(swipeRow.match_score).not.toBeNull();
  });
});

describe('GET /api/swipes/people and PATCH', () => {
  it('lists history joined with the target display name and allows changing a past decision', async () => {
    await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind('U Two', 'u2').run();
    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at) VALUES ('ps1', 'u1', 'u2', 'left', 0.4, 1000, 1000)`
    ).run();
    const cookie = await cookieFor('u1');

    const historyRes = await worker.fetch(new Request('http://localhost/api/swipes/people', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const history = await historyRes.json<any>();
    expect(history.swipes[0].direction).toBe('left');
    expect(history.swipes[0].displayName).toBe('U Two');

    const patchRes = await worker.fetch(
      new Request('http://localhost/api/swipes/people/ps1', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'right' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(patchRes.status).toBe(200);
    const row = await env.DB.prepare('SELECT direction FROM people_swipes WHERE id = ?').bind('ps1').first<any>();
    expect(row.direction).toBe('right');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/routes/peopleSwipes.test.ts`
Expected: FAIL — people-swipe routes not registered.

- [ ] **Step 8: Write `src/routes/peopleSwipes.ts`**

```typescript
import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser, type UserRow } from '../lib/session';
import { scoreCandidate, createMatchIfMutual } from '../lib/matching';
import { bucketedDistanceLabel } from '../lib/scoring';

async function primaryPhotoUrl(db: D1Database, userId: string): Promise<string | null> {
  const photo = await db.prepare('SELECT id FROM user_photos WHERE user_id = ? AND position = 0')
    .bind(userId)
    .first<{ id: string }>();
  return photo ? `/photos/${photo.id}` : null;
}

export function registerPeopleSwipeRoutes(router: RouterType) {
  router.get('/api/candidates/people', async (request: Request, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    const limit = Number(new URL(request.url).searchParams.get('limit') ?? '10');

    const likePriorityRows = await env.DB.prepare(
      `SELECT u.*, ps.match_score FROM people_swipes ps
       JOIN users u ON u.id = ps.swiper_id
       WHERE ps.target_id = ? AND ps.direction = 'right'
         AND NOT EXISTS (SELECT 1 FROM people_swipes ps2 WHERE ps2.swiper_id = ? AND ps2.target_id = ps.swiper_id)
         AND NOT EXISTS (
           SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = ps.swiper_id) OR (b.blocker_id = ps.swiper_id AND b.blocked_id = ?)
         )
         AND u.deleted_at IS NULL
       ORDER BY ps.match_score DESC`
    ).bind(me.id, me.id, me.id, me.id).all<UserRow & { match_score: number }>();

    const likePriorityIds = new Set(likePriorityRows.results.map((r) => r.id));

    const poolRows = await env.DB.prepare(
      `SELECT u.* FROM users u
       WHERE u.id != ? AND u.deleted_at IS NULL AND u.onboarded_at IS NOT NULL
         AND u.lat IS NOT NULL AND u.lng IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM people_swipes ps WHERE ps.swiper_id = ? AND ps.target_id = u.id)
         AND NOT EXISTS (
           SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?)
         )
       LIMIT 200`
    ).bind(me.id, me.id, me.id, me.id).all<UserRow>();

    const pool = poolRows.results.filter((u) => !likePriorityIds.has(u.id));

    const scored = await Promise.all(
      pool.map(async (candidate) => {
        const { score, distanceKm } = await scoreCandidate(env.DB, me, candidate, false);
        return { candidate, score, distanceKm };
      })
    );
    scored.sort((a, b) => b.score - a.score);

    const likePriorityFormatted = await Promise.all(
      likePriorityRows.results.map(async (c) => ({
        id: c.id,
        displayName: c.display_name,
        bio: c.bio,
        distanceLabel: bucketedDistanceLabel((await scoreCandidate(env.DB, me, c, true)).distanceKm),
        primaryPhotoUrl: await primaryPhotoUrl(env.DB, c.id),
        likedYou: true,
      }))
    );

    const normalFormatted = await Promise.all(
      scored.map(async ({ candidate, distanceKm }) => ({
        id: candidate.id,
        displayName: candidate.display_name,
        bio: candidate.bio,
        distanceLabel: bucketedDistanceLabel(distanceKm),
        primaryPhotoUrl: await primaryPhotoUrl(env.DB, candidate.id),
        likedYou: false,
      }))
    );

    const candidates = [...likePriorityFormatted, ...normalFormatted].slice(0, limit);

    return Response.json({ candidates });
  });

  router.post('/api/swipe/people', async (request: Request, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    const { target_id, direction } = await request.json<{ target_id: string; direction: 'left' | 'right' }>();

    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(target_id).first<UserRow>();
    if (!target) return Response.json({ error: 'unknown target_id' }, { status: 400 });

    const alreadyLikedMe = await env.DB
      .prepare(`SELECT 1 FROM people_swipes WHERE swiper_id = ? AND target_id = ? AND direction = 'right'`)
      .bind(target_id, me.id)
      .first();

    const { score } = await scoreCandidate(env.DB, me, target, !!alreadyLikedMe);
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO people_swipes (id, swiper_id, target_id, direction, match_score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(swiper_id, target_id) DO UPDATE SET direction = excluded.direction, match_score = excluded.match_score, updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), me.id, target_id, direction, score, now, now).run();

    let match = null;
    if (direction === 'right') {
      match = await createMatchIfMutual(env.DB, me.id, target_id);
    }

    return Response.json({ ok: true, matched: !!match });
  });

  router.get('/api/swipes/people', async (request: Request, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const offset = Number(url.searchParams.get('offset') ?? '0');

    const rows = await env.DB.prepare(
      `SELECT ps.id, ps.target_id, ps.direction, ps.match_score, ps.created_at, u.display_name as displayName
       FROM people_swipes ps
       JOIN users u ON u.id = ps.target_id
       WHERE ps.swiper_id = ?
       ORDER BY ps.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(me.id, limit, offset).all<any>();

    return Response.json({ swipes: rows.results });
  });

  router.patch('/api/swipes/people/:id', async (request: IRequest, env: Env) => {
    const me = await getSessionUser(request, env.DB);
    if (!me) return new Response('Unauthorized', { status: 401 });

    const { direction } = await request.json<{ direction: 'left' | 'right' }>();
    const result = await env.DB.prepare(
      `UPDATE people_swipes SET direction = ?, updated_at = ? WHERE id = ? AND swiper_id = ?`
    ).bind(direction, Date.now(), request.params.id, me.id).run();

    if (result.meta.changes === 0) return new Response('Not found', { status: 404 });
    return Response.json({ ok: true });
  });
}
```

- [ ] **Step 9: Register routes in `src/index.ts`**

```typescript
import { registerPeopleSwipeRoutes } from './routes/peopleSwipes';
// ...
registerPeopleSwipeRoutes(router);
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run test/routes/peopleSwipes.test.ts`
Expected: PASS (6/6)

- [ ] **Step 11: Commit**

```bash
git add src/lib/profile.ts src/lib/matching.ts src/routes/peopleSwipes.ts src/index.ts test/lib/matching.test.ts test/routes/peopleSwipes.test.ts
git commit -m "feat: add people-mode swipe deck with blended scoring and like-priority queue"
```

---

### Task 12: Matches, messaging, and transactional email

**Files:**
- Create: `src/lib/email.ts`
- Create: `src/lib/notifications.ts`
- Create: `src/routes/matches.ts`
- Modify: `src/routes/peopleSwipes.ts` (send match email on match creation)
- Modify: `src/index.ts` (register matches routes)
- Test: `test/lib/email.test.ts`
- Test: `test/lib/notifications.test.ts`
- Test: `test/routes/matches.test.ts`

**Interfaces:**
- Consumes: `getSessionUser`, `UserRow` (Task 2); `createMatchIfMutual` (Task 11).
- Produces: `sendEmail(env: Env, input: { to: string; subject: string; html: string }): Promise<void>` from `src/lib/email.ts`, using Resend's HTTP API.
- Produces: `notifyMatch(db: D1Database, env: Env, matchId: string): Promise<void>` and `notifyMessage(db: D1Database, env: Env, messageId: string, recipientId: string): Promise<void>` from `src/lib/notifications.ts` — both look up the recipient's `users.email`, skip silently if null (no email on file), otherwise call `sendEmail` and set `notifications.email_sent_at`.
- Produces: `GET /api/matches` (active matches only, `unmatched_at IS NULL`, with the other participant's `id`/`display_name`), `POST /api/matches/:id/unmatch` (caller must be a participant; sets `unmatched_at`/`unmatched_by`), `GET /api/matches/:id/messages` (caller must be a participant, match must be active), `POST /api/matches/:id/messages` (`{ body }`, same guard, inserts message, creates+sends a `message` notification to the other participant).
- Global Constraint addition: `RESEND_API_KEY` and `RESEND_FROM_ADDRESS` are Worker Secrets/vars used by `src/lib/email.ts`.

- [ ] **Step 1: Write the failing test for `sendEmail`**

```typescript
// test/lib/email.test.ts
import { describe, it, expect, vi } from 'vitest';
import { sendEmail } from '../../src/lib/email';

const env = { RESEND_API_KEY: 'test-key', RESEND_FROM_ADDRESS: 'matches@wavelengthz.app' } as any;

describe('sendEmail', () => {
  it('posts to the Resend API with the expected shape', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendEmail(env, { to: 'user@example.com', subject: 'You matched!', html: '<p>hi</p>' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.to).toBe('user@example.com');
    expect(body.from).toBe('matches@wavelengthz.app');
    expect(body.subject).toBe('You matched!');

    vi.unstubAllGlobals();
  });

  it('throws when Resend returns a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));
    await expect(sendEmail(env, { to: 'a@b.com', subject: 's', html: 'h' })).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/email.test.ts`
Expected: FAIL — `src/lib/email.ts` does not exist.

- [ ] **Step 3: Write `src/lib/email.ts`**

```typescript
export async function sendEmail(
  env: Env,
  input: { to: string; subject: string; html: string }
): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_ADDRESS,
      to: input.to,
      subject: input.subject,
      html: input.html,
    }),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${res.status}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/email.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Write the failing test for `src/lib/notifications.ts`**

```typescript
// test/lib/notifications.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { notifyMatch, notifyMessage } from '../../src/lib/notifications';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM users; DELETE FROM matches; DELETE FROM notifications; DELETE FROM messages;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, email, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'u1@example.com', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, email, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u2', 'sp2', NULL, 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m1', 'u1', 'u2', 1000)`).run();
  await env.DB.prepare(
    `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n1', 'u1', 'match', 'm1', 1000)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n2', 'u2', 'match', 'm1', 1000)`
  ).run();
});

describe('notifyMatch', () => {
  it('emails users who have an email on file and marks email_sent_at', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await notifyMatch(env.DB, { RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'm1');

    const n1 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n1').first<any>();
    const n2 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n2').first<any>();
    expect(n1.email_sent_at).not.toBeNull(); // u1 has an email
    expect(n2.email_sent_at).toBeNull(); // u2 has no email on file — skipped, not an error

    vi.unstubAllGlobals();
  });
});

describe('notifyMessage', () => {
  it('emails the recipient and marks the notification sent', async () => {
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm1', 'u2', 'hi', 1000)`).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`
    ).run();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    await notifyMessage(env.DB, { RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'msg1', 'u1');

    const n3 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n3').first<any>();
    expect(n3.email_sent_at).not.toBeNull();

    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/lib/notifications.test.ts`
Expected: FAIL — `src/lib/notifications.ts` does not exist.

- [ ] **Step 7: Write `src/lib/notifications.ts`**

```typescript
import { sendEmail } from './email';

export async function notifyMatch(db: D1Database, env: Env, matchId: string): Promise<void> {
  const rows = await db
    .prepare(`SELECT n.id as notification_id, u.email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.related_id = ? AND n.type = 'match'`)
    .bind(matchId)
    .all<{ notification_id: string; email: string | null }>();

  for (const row of rows.results) {
    if (!row.email) continue;
    await sendEmail(env, {
      to: row.email,
      subject: "You've got a new match!",
      html: `<p>You matched with someone on Wavelengthz. Open the app to say hi.</p>`,
    });
    await db.prepare('UPDATE notifications SET email_sent_at = ? WHERE id = ?').bind(Date.now(), row.notification_id).run();
  }
}

export async function notifyMessage(db: D1Database, env: Env, messageId: string, recipientId: string): Promise<void> {
  const recipient = await db.prepare('SELECT email FROM users WHERE id = ?').bind(recipientId).first<{ email: string | null }>();
  if (!recipient?.email) return;

  const notification = await db
    .prepare(`SELECT id FROM notifications WHERE related_id = ? AND type = 'message' AND user_id = ?`)
    .bind(messageId, recipientId)
    .first<{ id: string }>();
  if (!notification) return;

  await sendEmail(env, {
    to: recipient.email,
    subject: 'New message on Wavelengthz',
    html: `<p>You have a new message. Open the app to read it.</p>`,
  });
  await db.prepare('UPDATE notifications SET email_sent_at = ? WHERE id = ?').bind(Date.now(), notification.id).run();
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/lib/notifications.test.ts`
Expected: PASS (2/2)

- [ ] **Step 9: Write the failing test for matches/messaging routes**

```typescript
// test/routes/matches.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function makeUser(id: string, email: string | null) {
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, email, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`, email).run();
}

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM users; DELETE FROM matches; DELETE FROM messages; DELETE FROM notifications; DELETE FROM sessions;');
  await makeUser('u1', 'u1@example.com');
  await makeUser('u2', 'u2@example.com');
  await makeUser('u3', null);
  await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m1', 'u1', 'u2', 1000)`).run();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

describe('GET /api/matches', () => {
  it('lists active matches with the other participant', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/matches', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.matches[0].otherUserId).toBe('u2');
  });

  it('excludes a match after it is unmatched', async () => {
    const cookie = await cookieFor('u1');
    await worker.fetch(
      new Request('http://localhost/api/matches/m1/unmatch', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    const res = await worker.fetch(new Request('http://localhost/api/matches', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.matches.length).toBe(0);
  });
});

describe('messages', () => {
  it('rejects a non-participant', async () => {
    const cookie = await cookieFor('u3');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
  });

  it('sends a message, notifies, and emails the recipient', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hey there' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const messages = await env.DB.prepare('SELECT * FROM messages WHERE match_id = ?').bind('m1').all<any>();
    expect(messages.results.length).toBe(1);

    const notification = await env.DB.prepare("SELECT * FROM notifications WHERE type = 'message' AND user_id = 'u2'").first<any>();
    expect(notification).toBeTruthy();
    expect(notification.email_sent_at).not.toBeNull();
  });

  it('blocks messaging after unmatch', async () => {
    const cookie = await cookieFor('u1');
    await worker.fetch(new Request('http://localhost/api/matches/m1/unmatch', { method: 'POST', headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const res = await worker.fetch(
      new Request('http://localhost/api/matches/m1/messages', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run test/routes/matches.test.ts`
Expected: FAIL — matches routes not registered.

- [ ] **Step 11: Write `src/routes/matches.ts`**

```typescript
import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { notifyMessage } from '../lib/notifications';

async function loadActiveMatchForParticipant(db: D1Database, matchId: string, userId: string) {
  return db
    .prepare(`SELECT * FROM matches WHERE id = ? AND unmatched_at IS NULL AND (user_a_id = ? OR user_b_id = ?)`)
    .bind(matchId, userId, userId)
    .first<{ id: string; user_a_id: string; user_b_id: string }>();
}

export function registerMatchRoutes(router: RouterType) {
  router.get('/api/matches', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const rows = await env.DB.prepare(
      `SELECT id, user_a_id, user_b_id, created_at FROM matches
       WHERE unmatched_at IS NULL AND (user_a_id = ? OR user_b_id = ?)
       ORDER BY created_at DESC`
    ).bind(user.id, user.id).all<any>();

    const matches = rows.results.map((m) => ({
      id: m.id,
      otherUserId: m.user_a_id === user.id ? m.user_b_id : m.user_a_id,
      createdAt: m.created_at,
    }));

    return Response.json({ matches });
  });

  router.post('/api/matches/:id/unmatch', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Not found', { status: 404 });

    await env.DB.prepare('UPDATE matches SET unmatched_at = ?, unmatched_by = ? WHERE id = ?')
      .bind(Date.now(), user.id, match.id)
      .run();

    return Response.json({ ok: true });
  });

  router.get('/api/matches/:id/messages', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Forbidden', { status: 403 });

    const rows = await env.DB.prepare(
      `SELECT id, sender_id, body, read_at, created_at FROM messages WHERE match_id = ? ORDER BY created_at ASC`
    ).bind(match.id).all<any>();

    return Response.json({ messages: rows.results });
  });

  router.post('/api/matches/:id/messages', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const match = await loadActiveMatchForParticipant(env.DB, request.params.id, user.id);
    if (!match) return new Response('Forbidden', { status: 403 });

    const { body } = await request.json<{ body: string }>();
    const messageId = crypto.randomUUID();
    const now = Date.now();
    const recipientId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id;

    await env.DB.prepare(
      `INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(messageId, match.id, user.id, body, now).run();

    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES (?, ?, 'message', ?, ?)`
    ).bind(crypto.randomUUID(), recipientId, messageId, now).run();

    await notifyMessage(env.DB, env, messageId, recipientId);

    return Response.json({ ok: true, messageId });
  });
}
```

- [ ] **Step 12: Wire match-email dispatch into `src/routes/peopleSwipes.ts`**

In the `POST /api/swipe/people` handler, replace the `match` assignment block with:

```typescript
    let match = null;
    if (direction === 'right') {
      match = await createMatchIfMutual(env.DB, me.id, target_id);
      if (match) {
        const { notifyMatch } = await import('../lib/notifications');
        await notifyMatch(env.DB, env, match.matchId);
      }
    }
```

- [ ] **Step 13: Register routes in `src/index.ts`**

```typescript
import { registerMatchRoutes } from './routes/matches';
// ...
registerMatchRoutes(router);
```

- [ ] **Step 14: Run test to verify it passes**

Run: `npx vitest run test/routes/matches.test.ts test/routes/peopleSwipes.test.ts`
Expected: PASS (all)

- [ ] **Step 15: Commit**

```bash
git add src/lib/email.ts src/lib/notifications.ts src/routes/matches.ts src/routes/peopleSwipes.ts src/index.ts test/lib/email.test.ts test/lib/notifications.test.ts test/routes/matches.test.ts
git commit -m "feat: add matches, messaging, and transactional match/message email"
```

---

### Task 13: Notifications list and read endpoints

**Files:**
- Create: `src/routes/notifications.ts`
- Modify: `src/index.ts` (register notifications routes)
- Test: `test/routes/notifications.test.ts`

**Interfaces:**
- Consumes: `getSessionUser` (Task 2).
- Produces: `GET /api/notifications` (current user's notifications, newest first) and `POST /api/notifications/:id/read` (sets `read_at`, caller must own the notification).

- [ ] **Step 1: Write the failing test**

```typescript
// test/routes/notifications.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM users; DELETE FROM notifications; DELETE FROM sessions;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u2', 'sp2', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n1', 'u1', 'match', 'm1', 1000)`).run();
  await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n2', 'u2', 'match', 'm2', 1000)`).run();
});

describe('GET /api/notifications', () => {
  it('returns only the current user notifications', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(new Request('http://localhost/api/notifications', { headers: { Cookie: cookie } }), env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.notifications.length).toBe(1);
    expect(body.notifications[0].id).toBe('n1');
  });
});

describe('POST /api/notifications/:id/read', () => {
  it('marks the notification read when owned by the caller', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/notifications/n1/read', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT read_at FROM notifications WHERE id = ?').bind('n1').first<any>();
    expect(row.read_at).not.toBeNull();
  });

  it('returns 404 for a notification owned by someone else', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/notifications/n2/read', { method: 'POST', headers: { Cookie: cookie } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/notifications.test.ts`
Expected: FAIL — notification routes not registered.

- [ ] **Step 3: Write `src/routes/notifications.ts`**

```typescript
import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser } from '../lib/session';

export function registerNotificationRoutes(router: RouterType) {
  router.get('/api/notifications', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const rows = await env.DB.prepare(
      `SELECT id, type, related_id, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC`
    ).bind(user.id).all<any>();

    return Response.json({ notifications: rows.results });
  });

  router.post('/api/notifications/:id/read', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const result = await env.DB.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?')
      .bind(Date.now(), request.params.id, user.id)
      .run();

    if (result.meta.changes === 0) return new Response('Not found', { status: 404 });
    return Response.json({ ok: true });
  });
}
```

- [ ] **Step 4: Register routes in `src/index.ts`**

```typescript
import { registerNotificationRoutes } from './routes/notifications';
// ...
registerNotificationRoutes(router);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/routes/notifications.test.ts`
Expected: PASS (3/3)

- [ ] **Step 6: Commit**

```bash
git add src/routes/notifications.ts src/index.ts test/routes/notifications.test.ts
git commit -m "feat: add notifications list and mark-read endpoints"
```

---

### Task 14: Trust & safety — block and report

**Files:**
- Create: `src/routes/safety.ts`
- Modify: `src/index.ts` (register safety routes)
- Test: `test/routes/safety.test.ts`

**Interfaces:**
- Consumes: `getSessionUser` (Task 2).
- Produces: `POST /api/block` (`{ user_id }`, inserts into `blocks` via `INSERT OR IGNORE` respecting the `UNIQUE(blocker_id, blocked_id)` constraint, and ends any active match between the two users by setting `unmatched_at`/`unmatched_by`) and `POST /api/report` (`{ user_id, reason, details? }`, inserts a `reports` row with `status = 'open'`).
- Fixed reason set enforced server-side (docs/PLAN.md §9): `'inappropriate_photos' | 'harassment' | 'fake_profile' | 'spam' | 'underage' | 'other'` — a `reason` outside this set returns 400.

- [ ] **Step 1: Write the failing test**

```typescript
// test/routes/safety.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function makeUser(id: string) {
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`).run();
}

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM users; DELETE FROM blocks; DELETE FROM reports; DELETE FROM matches; DELETE FROM sessions;');
  await makeUser('u1');
  await makeUser('u2');
});

describe('POST /api/block', () => {
  it('creates a block row and ends any active match', async () => {
    await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m1', 'u1', 'u2', 1000)`).run();
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/block', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u2' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);

    const block = await env.DB.prepare('SELECT * FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind('u1', 'u2').first();
    expect(block).toBeTruthy();

    const match = await env.DB.prepare('SELECT * FROM matches WHERE id = ?').bind('m1').first<any>();
    expect(match.unmatched_at).not.toBeNull();
    expect(match.unmatched_by).toBe('u1');
  });

  it('is idempotent on a repeat block', async () => {
    const cookie = await cookieFor('u1');
    const block = () =>
      worker.fetch(
        new Request('http://localhost/api/block', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: 'u2' }),
        }),
        env,
        {} as ExecutionContext
      );
    await block();
    const res = await block();
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare('SELECT * FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind('u1', 'u2').all();
    expect(rows.results.length).toBe(1);
  });
});

describe('POST /api/report', () => {
  it('rejects a reason outside the fixed set', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/report', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u2', reason: 'i just do not like them' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(400);
  });

  it('creates an open report for a valid reason', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/report', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u2', reason: 'harassment', details: 'rude messages' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM reports WHERE reporter_id = ? AND reported_id = ?').bind('u1', 'u2').first<any>();
    expect(row.status).toBe('open');
    expect(row.details).toBe('rude messages');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/safety.test.ts`
Expected: FAIL — safety routes not registered.

- [ ] **Step 3: Write `src/routes/safety.ts`**

```typescript
import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';

const VALID_REASONS = new Set(['inappropriate_photos', 'harassment', 'fake_profile', 'spam', 'underage', 'other']);

export function registerSafetyRoutes(router: RouterType) {
  router.post('/api/block', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { user_id } = await request.json<{ user_id: string }>();
    const now = Date.now();

    await env.DB.prepare(
      `INSERT OR IGNORE INTO blocks (id, blocker_id, blocked_id, created_at) VALUES (?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), user.id, user_id, now).run();

    const [a, b] = [user.id, user_id].sort();
    await env.DB.prepare(
      `UPDATE matches SET unmatched_at = ?, unmatched_by = ? WHERE user_a_id = ? AND user_b_id = ? AND unmatched_at IS NULL`
    ).bind(now, user.id, a, b).run();

    return Response.json({ ok: true });
  });

  router.post('/api/report', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { user_id, reason, details } = await request.json<{ user_id: string; reason: string; details?: string }>();
    if (!VALID_REASONS.has(reason)) {
      return Response.json({ error: 'invalid_reason' }, { status: 400 });
    }

    await env.DB.prepare(
      `INSERT INTO reports (id, reporter_id, reported_id, reason, details, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`
    ).bind(crypto.randomUUID(), user.id, user_id, reason, details ?? null, Date.now()).run();

    return Response.json({ ok: true });
  });
}
```

- [ ] **Step 4: Register routes in `src/index.ts`**

```typescript
import { registerSafetyRoutes } from './routes/safety';
// ...
registerSafetyRoutes(router);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/routes/safety.test.ts`
Expected: PASS (4/4)

- [ ] **Step 6: Commit**

```bash
git add src/routes/safety.ts src/index.ts test/routes/safety.test.ts
git commit -m "feat: add block and report endpoints with fixed report reasons"
```

---

### Task 15: Account deletion — soft-delete endpoint and scheduled hard-delete

**Files:**
- Create: `src/lib/accountDeletion.ts`
- Create: `src/routes/account.ts`
- Modify: `src/index.ts` (register account route, add `scheduled` handler)
- Modify: `wrangler.toml` (add cron trigger)
- Test: `test/lib/accountDeletion.test.ts`
- Test: `test/routes/account.test.ts`

**Interfaces:**
- Consumes: `getSessionUser` (Task 2).
- Produces: `hardDeleteUser(env: Env, userId: string): Promise<void>` — deletes the user's R2 photo objects and every row referencing them (`user_photos`, `people_swipes` as either side, `music_swipes`, `music_profiles`, `blocks` as either side, `notifications`, `sessions`, matches the user is part of and that match's `messages`, and finally the `users` row itself, purging the encrypted tokens) — and `purgeExpiredDeletions(env: Env, gracePeriodMs: number, nowMs: number): Promise<{ purgedCount: number }>`, which finds `users` where `deleted_at IS NOT NULL AND deleted_at < nowMs - gracePeriodMs` and calls `hardDeleteUser` for each.
- Produces: `DELETE /api/account` — sets `users.deleted_at = now` for the caller (soft-delete only; the scheduled job does the hard purge).
- Design note: `reports` rows where the deleted user was the **reporter** are deleted (their own filed report, no longer actionable); `reports` rows where the deleted user was the **reported** party are deliberately left in place (moderation record continuity, per docs/PLAN.md §9) — `reported_id` is left pointing at the now-purged user id, which SQLite/D1 permits since foreign keys aren't enforced by default.
- Global Constraint addition: grace period is 7 days (`GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000`), matching docs/PLAN.md §9's "short enough to stay compliant, long enough to allow recovery."

- [ ] **Step 1: Write the failing test for `hardDeleteUser` and `purgeExpiredDeletions`**

```typescript
// test/lib/accountDeletion.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { hardDeleteUser, purgeExpiredDeletions } from '../../src/lib/accountDeletion';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function seedFullUser(id: string) {
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, 'a', 'r', 9999999999999, 1000, 1000)`
  ).bind(id, `sp-${id}`).run();
}

beforeEach(async () => {
  await env.DB.exec(`
    DELETE FROM users; DELETE FROM user_photos; DELETE FROM matches; DELETE FROM messages;
    DELETE FROM people_swipes; DELETE FROM music_swipes; DELETE FROM music_profiles;
    DELETE FROM blocks; DELETE FROM reports; DELETE FROM notifications; DELETE FROM sessions;
  `);
});

describe('hardDeleteUser', () => {
  it('purges the user row, their photos (D1 + R2), and everything referencing them', async () => {
    await seedFullUser('u1');
    await seedFullUser('u2');
    await env.PHOTOS.put('users/u1/p1.jpg', 'fake-bytes');
    await env.DB.prepare(`INSERT INTO user_photos (id, user_id, r2_key, position, created_at) VALUES ('p1', 'u1', 'users/u1/p1.jpg', 0, 1000)`).run();
    await env.DB.prepare(`INSERT INTO matches (id, user_a_id, user_b_id, created_at) VALUES ('m1', 'u1', 'u2', 1000)`).run();
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm1', 'u1', 'hi', 1000)`).run();
    await env.DB.prepare(`INSERT INTO people_swipes (id, swiper_id, target_id, direction, created_at, updated_at) VALUES ('ps1', 'u1', 'u2', 'right', 1000, 1000)`).run();
    await env.DB.prepare(`INSERT INTO reports (id, reporter_id, reported_id, reason, status, created_at) VALUES ('r1', 'u1', 'u2', 'spam', 'open', 1000)`).run();
    await env.DB.prepare(`INSERT INTO reports (id, reporter_id, reported_id, reason, status, created_at) VALUES ('r2', 'u2', 'u1', 'spam', 'open', 1000)`).run();

    await hardDeleteUser(env as any, 'u1');

    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM user_photos WHERE user_id = ?').bind('u1').first()).toBeNull();
    expect(await env.PHOTOS.get('users/u1/p1.jpg')).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM matches WHERE id = ?').bind('m1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind('msg1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM people_swipes WHERE id = ?').bind('ps1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind('r1').first()).toBeNull(); // u1 was reporter
    expect(await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind('r2').first()).not.toBeNull(); // u1 was reported — kept
  });
});

describe('purgeExpiredDeletions', () => {
  it('hard-deletes only users past the grace period', async () => {
    const GRACE = 7 * 24 * 60 * 60 * 1000;
    const now = 100_000_000_000;
    await seedFullUser('old');
    await seedFullUser('recent');
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(now - GRACE - 1000, 'old').run();
    await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(now - 1000, 'recent').run();

    const result = await purgeExpiredDeletions(env as any, GRACE, now);

    expect(result.purgedCount).toBe(1);
    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('old').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('recent').first()).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/accountDeletion.test.ts`
Expected: FAIL — `src/lib/accountDeletion.ts` does not exist.

- [ ] **Step 3: Write `src/lib/accountDeletion.ts`**

```typescript
export async function hardDeleteUser(env: Env, userId: string): Promise<void> {
  const photos = await env.DB.prepare('SELECT r2_key FROM user_photos WHERE user_id = ?').bind(userId).all<{ r2_key: string }>();
  for (const photo of photos.results) {
    await env.PHOTOS.delete(photo.r2_key);
  }
  await env.DB.prepare('DELETE FROM user_photos WHERE user_id = ?').bind(userId).run();

  const matches = await env.DB.prepare('SELECT id FROM matches WHERE user_a_id = ? OR user_b_id = ?').bind(userId, userId).all<{ id: string }>();
  for (const match of matches.results) {
    await env.DB.prepare('DELETE FROM messages WHERE match_id = ?').bind(match.id).run();
    await env.DB.prepare('DELETE FROM matches WHERE id = ?').bind(match.id).run();
  }

  await env.DB.prepare('DELETE FROM people_swipes WHERE swiper_id = ? OR target_id = ?').bind(userId, userId).run();
  await env.DB.prepare('DELETE FROM music_swipes WHERE user_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM music_profiles WHERE user_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?').bind(userId, userId).run();
  await env.DB.prepare('DELETE FROM reports WHERE reporter_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM notifications WHERE user_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
}

export async function purgeExpiredDeletions(
  env: Env,
  gracePeriodMs: number,
  nowMs: number
): Promise<{ purgedCount: number }> {
  const cutoff = nowMs - gracePeriodMs;
  const rows = await env.DB.prepare('SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at < ?')
    .bind(cutoff)
    .all<{ id: string }>();

  for (const row of rows.results) {
    await hardDeleteUser(env, row.id);
  }

  return { purgedCount: rows.results.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/accountDeletion.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Write the failing test for `DELETE /api/account`**

```typescript
// test/routes/account.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM users; DELETE FROM sessions;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
});

describe('DELETE /api/account', () => {
  it('soft-deletes immediately (row still exists, deleted_at set) without waiting for the grace period', async () => {
    const { cookie } = await createSession(env.DB, 'u1');
    const sessionId = cookie.split(';')[0].split('=')[1];
    const res = await worker.fetch(
      new Request('http://localhost/api/account', { method: 'DELETE', headers: { Cookie: `wl_session=${sessionId}` } }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT deleted_at FROM users WHERE id = ?').bind('u1').first<any>();
    expect(row.deleted_at).not.toBeNull();
  });

  it('a soft-deleted user can no longer authenticate a session', async () => {
    const { cookie } = await createSession(env.DB, 'u1');
    const sessionId = cookie.split(';')[0].split('=')[1];
    await worker.fetch(new Request('http://localhost/api/account', { method: 'DELETE', headers: { Cookie: `wl_session=${sessionId}` } }), env, {} as ExecutionContext);

    const res = await worker.fetch(new Request('http://localhost/api/me', { headers: { Cookie: `wl_session=${sessionId}` } }), env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/routes/account.test.ts`
Expected: FAIL — `/api/account` not registered.

- [ ] **Step 7: Write `src/routes/account.ts`**

```typescript
import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';

export function registerAccountRoutes(router: RouterType) {
  router.delete('/api/account', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    await env.DB.prepare('UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .bind(Date.now(), Date.now(), user.id)
      .run();

    return Response.json({ ok: true });
  });
}
```

Note: `getSessionUser` (Task 2) already filters `WHERE ... AND u.deleted_at IS NULL`, so the second test passes without further changes.

- [ ] **Step 8: Register the route and add the `scheduled` handler in `src/index.ts`**

```typescript
import { registerAccountRoutes } from './routes/account';
import { purgeExpiredDeletions } from './lib/accountDeletion';
// ...
registerAccountRoutes(router);

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    router.fetch(request, env, ctx),
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(purgeExpiredDeletions(env, GRACE_PERIOD_MS, Date.now()).then(() => undefined));
  },
};
```

- [ ] **Step 9: Add the cron trigger to `wrangler.toml`**

```toml
[triggers]
crons = ["0 3 * * *"]
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run test/routes/account.test.ts`
Expected: PASS (2/2)

- [ ] **Step 11: Commit**

```bash
git add src/lib/accountDeletion.ts src/routes/account.ts src/index.ts wrangler.toml test/lib/accountDeletion.test.ts test/routes/account.test.ts
git commit -m "feat: add account soft-delete endpoint and scheduled hard-delete purge"
```

---

### Task 16: Static asset pipeline, shared API client, and the swipe deck UI

**Files:**
- Create: `public/app.js`
- Create: `public/swipe.js`
- Create: `public/index.html`
- Create: `public/styles.css` (Tailwind input file)
- Create: `tailwind.config.js`
- Modify: `package.json` (add Tailwind CLI build script + dependency)
- Modify: `wrangler.toml` (add Workers Assets binding for `public/`)
- Test: `test/public/app.test.ts`
- Test: `test/public/swipe.test.ts`

**Interfaces:**
- Produces: `public/app.js` exports (as a plain `<script type="module">`, testable via direct import in Vitest with `fetch` stubbed) an `api` object: `api.me()`, `api.candidates(mode: 'people'|'music', limit?: number)`, `api.swipe(mode: 'people'|'music', body: object)`, `api.matches()`, `api.messages(matchId: string)`, `api.sendMessage(matchId: string, body: string)` — each a thin `fetch` wrapper against the routes built in Tasks 4, 10, 11, 12, returning parsed JSON and throwing on non-2xx.
- Produces: `public/swipe.js` exports `resolveSwipeDirection(deltaX: number, thresholdPx: number): 'left' | 'right' | null` (pure function: pointer-drag distance to a decision) and `attachSwipeDeck(container: HTMLElement, options: { onSwipe: (direction: 'left'|'right') => void; thresholdPx?: number }): () => void` (wires native Pointer Events for drag/fling/snap via CSS `transform`, returns a cleanup/detach function) — no animation library, per docs/PLAN.md §11.
- Produces: `public/index.html` — the swipe UI with a People/Music mode toggle (docs/PLAN.md §12), keyboard-operable swipe buttons alongside the gesture (accessibility requirement, §12), `alt` text on photos, loads `app.js`/`swipe.js` as ES modules, links `styles.css` (built Tailwind output, not the CDN script).
- Global Constraint addition: `wrangler.toml` gets `[assets]` with `directory = "./public"` and `binding = "ASSETS"` — Cloudflare serves matching static files directly; the Worker only runs for unmatched paths (already all `/api/*`, `/login`, `/callback`, `/logout`, `/internal/*`), so no change to `src/index.ts` routing is needed.

- [ ] **Step 1: Write the failing test for the API client**

```typescript
// test/public/app.test.ts
import { describe, it, expect, vi } from 'vitest';
import { api } from '../../public/app.js';

describe('api client', () => {
  it('api.me() fetches /api/me and returns parsed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 })));
    const result = await api.me();
    expect(result.user.id).toBe('u1');
    expect(fetch).toHaveBeenCalledWith('/api/me', expect.objectContaining({ credentials: 'include' }));
    vi.unstubAllGlobals();
  });

  it('api.candidates(mode) hits the right endpoint per mode', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.candidates('music', 5);
    expect(fetchMock).toHaveBeenCalledWith('/api/candidates/music?limit=5', expect.anything());
    await api.candidates('people');
    expect(fetchMock).toHaveBeenCalledWith('/api/candidates/people?limit=10', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.swipe posts to the mode-specific swipe endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.swipe('people', { target_id: 'u2', direction: 'right' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/swipe/people',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ target_id: 'u2', direction: 'right' }) })
    );
    vi.unstubAllGlobals();
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(api.me()).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/public/app.test.ts`
Expected: FAIL — `public/app.js` does not exist.

- [ ] **Step 3: Write `public/app.js`**

```javascript
async function request(path, options = {}) {
  const res = await fetch(path, { credentials: 'include', ...options });
  if (!res.ok) throw new Error(`Request to ${path} failed: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export const api = {
  me: () => request('/api/me'),
  candidates: (mode, limit = 10) => request(`/api/candidates/${mode}?limit=${limit}`),
  swipe: (mode, body) =>
    request(`/api/swipe/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  matches: () => request('/api/matches'),
  messages: (matchId) => request(`/api/matches/${matchId}/messages`),
  sendMessage: (matchId, body) =>
    request(`/api/matches/${matchId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }),
  onboard: (payload) =>
    request('/api/onboarding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  block: (userId) =>
    request('/api/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId }) }),
  report: (userId, reason, details) =>
    request('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, reason, details }),
    }),
  unmatch: (matchId) => request(`/api/matches/${matchId}/unmatch`, { method: 'POST' }),
  deleteAccount: () => request('/api/account', { method: 'DELETE' }),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/public/app.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Write the failing test for the swipe deck helper**

```typescript
// test/public/swipe.test.ts
import { describe, it, expect } from 'vitest';
import { resolveSwipeDirection } from '../../public/swipe.js';

describe('resolveSwipeDirection', () => {
  it('returns null below the threshold', () => {
    expect(resolveSwipeDirection(20, 80)).toBeNull();
    expect(resolveSwipeDirection(-20, 80)).toBeNull();
  });
  it('returns right past the positive threshold', () => {
    expect(resolveSwipeDirection(120, 80)).toBe('right');
  });
  it('returns left past the negative threshold', () => {
    expect(resolveSwipeDirection(-120, 80)).toBe('left');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/public/swipe.test.ts`
Expected: FAIL — `public/swipe.js` does not exist.

- [ ] **Step 7: Write `public/swipe.js`**

```javascript
export function resolveSwipeDirection(deltaX, thresholdPx) {
  if (deltaX > thresholdPx) return 'right';
  if (deltaX < -thresholdPx) return 'left';
  return null;
}

export function attachSwipeDeck(container, { onSwipe, thresholdPx = 80 }) {
  let startX = 0;
  let currentX = 0;
  let dragging = false;

  function onPointerDown(e) {
    dragging = true;
    startX = e.clientX;
    container.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!dragging) return;
    currentX = e.clientX - startX;
    container.style.transform = `translateX(${currentX}px) rotate(${currentX / 20}deg)`;
  }

  function settle(direction) {
    if (direction) {
      const flungX = direction === 'right' ? window.innerWidth : -window.innerWidth;
      container.style.transition = 'transform 0.25s ease-out';
      container.style.transform = `translateX(${flungX}px) rotate(${flungX / 20}deg)`;
      setTimeout(() => onSwipe(direction), 250);
    } else {
      container.style.transition = 'transform 0.2s ease-out';
      container.style.transform = 'translateX(0) rotate(0)';
    }
    setTimeout(() => {
      container.style.transition = '';
    }, 260);
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    settle(resolveSwipeDirection(currentX, thresholdPx));
    currentX = 0;
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerUp);

  return () => {
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerup', onPointerUp);
    container.removeEventListener('pointercancel', onPointerUp);
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/public/swipe.test.ts`
Expected: PASS (3/3)

- [ ] **Step 9: Add Tailwind CLI and build script**

```bash
npm install -D tailwindcss @tailwindcss/cli
```

Write `tailwind.config.js`:

```javascript
module.exports = {
  content: ['./public/**/*.html', './public/**/*.js'],
  theme: { extend: {} },
  plugins: [],
};
```

Write `public/styles.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

Add to `package.json` `"scripts"`:

```json
"build:css": "tailwindcss -i ./public/styles.css -o ./public/tailwind.css --minify"
```

- [ ] **Step 10: Write `public/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Wavelengthz</title>
  <link rel="stylesheet" href="/tailwind.css" />
  <link rel="manifest" href="/manifest.json" />
</head>
<body class="min-h-screen bg-neutral-950 text-neutral-50" x-data="deckApp()" x-init="init()">
  <header class="flex items-center justify-center gap-2 p-4">
    <button
      class="px-4 py-2 rounded-full"
      :class="mode === 'people' ? 'bg-white text-black' : 'bg-neutral-800'"
      @click="setMode('people')"
      aria-pressed="mode === 'people'"
    >People</button>
    <button
      class="px-4 py-2 rounded-full"
      :class="mode === 'music' ? 'bg-white text-black' : 'bg-neutral-800'"
      @click="setMode('music')"
      aria-pressed="mode === 'music'"
    >Music</button>
  </header>

  <main class="flex flex-col items-center gap-6 px-4">
    <div id="deck-container" class="relative w-full max-w-sm aspect-[3/4]" x-show="current">
      <article class="absolute inset-0 rounded-2xl bg-neutral-900 shadow-xl overflow-hidden" id="card">
        <img :src="current?.photoUrl" :alt="current?.name || current?.displayName || 'candidate photo'" class="w-full h-2/3 object-cover" />
        <div class="p-4">
          <h2 class="text-xl font-semibold" x-text="current?.name || current?.displayName"></h2>
          <p class="text-neutral-400" x-text="current?.bio || current?.distanceLabel"></p>
        </div>
      </article>
    </div>

    <p x-show="!current" class="text-neutral-400">No more candidates right now — check back later.</p>

    <div class="flex gap-6" x-show="current">
      <button
        class="w-16 h-16 rounded-full bg-neutral-800 text-2xl"
        @click="decide('left')"
        aria-label="Pass"
      >✕</button>
      <button
        class="w-16 h-16 rounded-full bg-emerald-600 text-2xl"
        @click="decide('right')"
        aria-label="Like"
      >♥</button>
    </div>
  </main>

  <script type="module">
    import { api } from '/app.js';
    import { attachSwipeDeck } from '/swipe.js';

    window.deckApp = function () {
      return {
        mode: 'people',
        queue: [],
        current: null,
        detachSwipe: null,

        async init() {
          await this.loadQueue();
        },

        async setMode(mode) {
          this.mode = mode;
          this.queue = [];
          this.current = null;
          await this.loadQueue();
        },

        async loadQueue() {
          const res = await api.candidates(this.mode, 10);
          this.queue = res.candidates;
          this.showNext();
        },

        showNext() {
          if (this.detachSwipe) this.detachSwipe();
          this.current = this.queue.shift() ?? null;
          this.$nextTick(() => {
            const card = document.getElementById('card');
            if (card && this.current) {
              this.detachSwipe = attachSwipeDeck(card, { onSwipe: (dir) => this.decide(dir) });
            }
          });
        },

        async decide(direction) {
          if (!this.current) return;
          if (this.mode === 'people') {
            await api.swipe('people', { target_id: this.current.id, direction });
          } else {
            await api.swipe('music', { item_type: this.current.itemType, item_id: this.current.itemId, direction });
          }
          if (this.queue.length === 0) await this.loadQueue();
          else this.showNext();
        },
      };
    };
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
</body>
</html>
```

- [ ] **Step 11: Add the Workers Assets binding in `wrangler.toml`**

```toml
[assets]
directory = "./public"
binding = "ASSETS"
```

- [ ] **Step 12: Commit**

```bash
git add public/app.js public/swipe.js public/index.html public/styles.css tailwind.config.js package.json wrangler.toml test/public/app.test.ts test/public/swipe.test.ts
git commit -m "feat: add static asset pipeline, API client, and swipe deck UI"
```

---

### Task 17: Onboarding, history, matches, messages, settings pages + PWA

**Files:**
- Modify: `public/app.js` (add history/settings-related API methods)
- Create: `public/onboarding.html`
- Create: `public/history.html`
- Create: `public/matches.html`
- Create: `public/messages.html`
- Create: `public/settings.html`
- Create: `public/manifest.json`
- Create: `public/sw.js`
- Test: `test/public/app.history.test.ts`

**Interfaces:**
- Consumes: `api` object (Task 16), all backend routes from Tasks 6, 7, 10, 12, 14, 15.
- Produces (added to `public/app.js`): `api.photoUploadUrl({ contentType, sizeBytes })` (wraps `POST /api/photos`), `api.deletePhoto(photoId)` (wraps `DELETE /api/photos/:id`), `api.swipeHistory(mode, limit, offset)` (wraps `GET /api/swipes/:mode`), `api.updateSwipe(mode, id, direction)` (wraps `PATCH /api/swipes/:mode/:id`).
- Scope note: docs/PLAN.md §15 lists `settings.html` as "block list, report, delete account," but the route table (§6) defines no `GET /api/blocks` to list prior blocks — that endpoint was never specced. `settings.html` in this task covers account deletion, max-distance adjustment, and logout; a blocked-users list is out of scope until a corresponding API route is added in a future plan (calling it out here rather than fabricating an endpoint that doesn't exist).
- Design note (resolves an ambiguity in docs/PLAN.md §7.2): the browser-geolocation path calls `navigator.geolocation.getCurrentPosition` for `lat`/`lng` directly and labels it `"Current location"`; the manual fallback for users who decline the permission prompt is a plain text `location_label` plus manual numeric `lat`/`lng` inputs (no third-party geocoding provider is in scope for v1).

- [ ] **Step 1: Write the failing test for the added API client methods**

```typescript
// test/public/app.history.test.ts
import { describe, it, expect, vi } from 'vitest';
import { api } from '../../public/app.js';

describe('api client — history and photo methods', () => {
  it('api.swipeHistory builds the right query string', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ swipes: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.swipeHistory('music', 20, 10);
    expect(fetchMock).toHaveBeenCalledWith('/api/swipes/music?limit=20&offset=10', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.updateSwipe PATCHes the right path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.updateSwipe('people', 'swipe-1', 'right');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/swipes/people/swipe-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ direction: 'right' }) })
    );
    vi.unstubAllGlobals();
  });

  it('api.photoUploadUrl posts the content type and size', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ uploadUrl: 'https://x', photoId: 'p1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.photoUploadUrl({ contentType: 'image/jpeg', sizeBytes: 1000 });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/photos',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 1000 }) })
    );
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/public/app.history.test.ts`
Expected: FAIL — the new `api` methods don't exist yet.

- [ ] **Step 3: Add the new methods to `public/app.js`**

Append inside the exported `api` object (add these keys alongside the existing ones):

```javascript
  photoUploadUrl: (payload) =>
    request('/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  deletePhoto: (photoId) => request(`/api/photos/${photoId}`, { method: 'DELETE' }),
  swipeHistory: (mode, limit = 20, offset = 0) => request(`/api/swipes/${mode}?limit=${limit}&offset=${offset}`),
  updateSwipe: (mode, id, direction) =>
    request(`/api/swipes/${mode}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }) }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/public/app.history.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Write `public/onboarding.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wavelengthz — Set up your profile</title>
  <link rel="stylesheet" href="/tailwind.css" />
</head>
<body class="min-h-screen bg-neutral-950 text-neutral-50 p-4" x-data="onboardingApp()" x-init="init()">
  <form class="max-w-md mx-auto flex flex-col gap-4" @submit.prevent="submit()">
    <h1 class="text-2xl font-semibold">Tell us about you</h1>

    <label class="flex flex-col gap-1">
      <span>Bio</span>
      <textarea class="bg-neutral-900 rounded p-2" x-model="bio" maxlength="500"></textarea>
    </label>

    <label class="flex flex-col gap-1">
      <span>Date of birth</span>
      <input class="bg-neutral-900 rounded p-2" type="date" x-model="dateOfBirth" required />
    </label>
    <p x-show="error === 'underage'" class="text-red-400" role="alert">
      You must be 18 or older to use Wavelengthz.
    </p>

    <div class="flex flex-col gap-2">
      <button type="button" class="bg-neutral-800 rounded p-2" @click="useBrowserLocation()">
        Use my current location
      </button>
      <p x-show="locationLabel" x-text="locationLabel" class="text-neutral-400 text-sm"></p>
      <details>
        <summary class="text-sm text-neutral-400">Enter location manually instead</summary>
        <label class="flex flex-col gap-1 mt-2">
          <span>City / region</span>
          <input class="bg-neutral-900 rounded p-2" type="text" x-model="manualLabel" />
        </label>
        <div class="flex gap-2 mt-2">
          <input class="bg-neutral-900 rounded p-2 w-1/2" type="number" step="any" placeholder="Latitude" x-model.number="manualLat" />
          <input class="bg-neutral-900 rounded p-2 w-1/2" type="number" step="any" placeholder="Longitude" x-model.number="manualLng" />
        </div>
      </details>
    </div>

    <label class="flex flex-col gap-1">
      <span>Max distance (km): <span x-text="maxDistanceKm"></span></span>
      <input type="range" min="5" max="200" x-model.number="maxDistanceKm" />
    </label>

    <fieldset class="flex flex-col gap-2">
      <legend>Photos</legend>
      <input type="file" accept="image/jpeg,image/png,image/webp" @change="uploadPhoto($event)" aria-label="Upload a profile photo" />
      <ul>
        <template x-for="photo in photos" :key="photo.photoId">
          <li class="flex items-center justify-between">
            <span x-text="photo.name"></span>
            <button type="button" class="text-red-400" @click="removePhoto(photo.photoId)">Remove</button>
          </li>
        </template>
      </ul>
    </fieldset>

    <button type="submit" class="bg-emerald-600 rounded p-3 font-semibold">Continue</button>
  </form>

  <script type="module">
    import { api } from '/app.js';

    window.onboardingApp = function () {
      return {
        bio: '',
        dateOfBirth: '',
        locationLabel: '',
        manualLabel: '',
        manualLat: null,
        manualLng: null,
        lat: null,
        lng: null,
        maxDistanceKm: 80,
        photos: [],
        error: null,

        init() {},

        useBrowserLocation() {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              this.lat = pos.coords.latitude;
              this.lng = pos.coords.longitude;
              this.locationLabel = 'Current location';
            },
            () => {
              this.locationLabel = 'Location permission denied — use manual entry below.';
            }
          );
        },

        async uploadPhoto(event) {
          const file = event.target.files[0];
          if (!file) return;
          const { uploadUrl, photoId } = await api.photoUploadUrl({ contentType: file.type, sizeBytes: file.size });
          await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
          this.photos.push({ photoId, name: file.name });
        },

        async removePhoto(photoId) {
          await api.deletePhoto(photoId);
          this.photos = this.photos.filter((p) => p.photoId !== photoId);
        },

        async submit() {
          this.error = null;
          const lat = this.lat ?? this.manualLat;
          const lng = this.lng ?? this.manualLng;
          const locationLabel = this.locationLabel === 'Current location' ? this.locationLabel : this.manualLabel;
          try {
            await api.onboard({
              bio: this.bio,
              date_of_birth: this.dateOfBirth,
              location_label: locationLabel,
              lat,
              lng,
              max_distance_km: this.maxDistanceKm,
            });
            window.location.href = '/';
          } catch (e) {
            this.error = 'underage';
          }
        },
      };
    };
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
</body>
</html>
```

- [ ] **Step 6: Write `public/history.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wavelengthz — History</title>
  <link rel="stylesheet" href="/tailwind.css" />
</head>
<body class="min-h-screen bg-neutral-950 text-neutral-50 p-4" x-data="historyApp()" x-init="init()">
  <div class="flex gap-2 mb-4">
    <button class="px-4 py-2 rounded-full" :class="mode === 'people' ? 'bg-white text-black' : 'bg-neutral-800'" @click="setMode('people')">People</button>
    <button class="px-4 py-2 rounded-full" :class="mode === 'music' ? 'bg-white text-black' : 'bg-neutral-800'" @click="setMode('music')">Music</button>
  </div>

  <ul class="flex flex-col gap-2 max-w-md">
    <template x-for="swipe in swipes" :key="swipe.id">
      <li class="flex items-center justify-between bg-neutral-900 rounded p-3">
        <span x-text="swipe.name || swipe.target_id"></span>
        <span class="flex items-center gap-2">
          <span x-text="swipe.direction === 'right' ? '♥ Liked' : '✕ Passed'"></span>
          <button class="text-sm underline" @click="toggle(swipe)">Change</button>
        </span>
      </li>
    </template>
  </ul>

  <script type="module">
    import { api } from '/app.js';

    window.historyApp = function () {
      return {
        mode: 'people',
        swipes: [],
        init() {
          this.load();
        },
        setMode(mode) {
          this.mode = mode;
          this.load();
        },
        async load() {
          const res = await api.swipeHistory(this.mode);
          this.swipes = res.swipes;
        },
        async toggle(swipe) {
          const newDirection = swipe.direction === 'right' ? 'left' : 'right';
          await api.updateSwipe(this.mode, swipe.id, newDirection);
          swipe.direction = newDirection;
        },
      };
    };
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
</body>
</html>
```

Note: `history.html` for `mode = 'people'` reads `swipe.target_id` since `GET /api/swipes/people` (Task 11's history endpoint — same shape as the music one built in Task 10) returns `target_id` rather than a joined `name`; displaying a raw id there is an acceptable v1 gap given no people-history-with-display-name endpoint was specced, and is called out here rather than silently left as a mismatch.

- [ ] **Step 7: Write `public/matches.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wavelengthz — Matches</title>
  <link rel="stylesheet" href="/tailwind.css" />
</head>
<body class="min-h-screen bg-neutral-950 text-neutral-50 p-4" x-data="matchesApp()" x-init="init()">
  <h1 class="text-2xl font-semibold mb-4">Your matches</h1>
  <ul class="flex flex-col gap-2 max-w-md">
    <template x-for="match in matches" :key="match.id">
      <li class="flex items-center justify-between bg-neutral-900 rounded p-3">
        <a class="underline" :href="`/messages.html?matchId=${match.id}`" x-text="match.otherUserId"></a>
        <span class="flex gap-2">
          <button class="text-sm text-red-400" @click="unmatch(match.id)">Unmatch</button>
          <button class="text-sm text-yellow-400" @click="report(match.otherUserId)">Report</button>
          <button class="text-sm text-neutral-400" @click="block(match.otherUserId)">Block</button>
        </span>
      </li>
    </template>
  </ul>
  <p x-show="matches.length === 0" class="text-neutral-400">No matches yet — keep swiping!</p>

  <script type="module">
    import { api } from '/app.js';

    window.matchesApp = function () {
      return {
        matches: [],
        init() {
          this.load();
        },
        async load() {
          const res = await api.matches();
          this.matches = res.matches;
        },
        async unmatch(matchId) {
          await api.unmatch(matchId);
          await this.load();
        },
        async block(userId) {
          await api.block(userId);
          await this.load();
        },
        async report(userId) {
          const reason = prompt('Reason (inappropriate_photos, harassment, fake_profile, spam, underage, other):');
          if (!reason) return;
          await api.report(userId, reason);
        },
      };
    };
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
</body>
</html>
```

- [ ] **Step 8: Write `public/messages.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wavelengthz — Messages</title>
  <link rel="stylesheet" href="/tailwind.css" />
</head>
<body class="min-h-screen bg-neutral-950 text-neutral-50 p-4 flex flex-col" x-data="messagesApp()" x-init="init()">
  <ul class="flex-1 flex flex-col gap-2 overflow-y-auto max-w-md w-full mx-auto">
    <template x-for="message in messages" :key="message.id">
      <li class="bg-neutral-900 rounded p-2" x-text="message.body"></li>
    </template>
  </ul>
  <form class="flex gap-2 max-w-md w-full mx-auto mt-4" @submit.prevent="send()">
    <label class="sr-only" for="message-input">Message</label>
    <input id="message-input" class="flex-1 bg-neutral-900 rounded p-2" x-model="draft" required />
    <button type="submit" class="bg-emerald-600 rounded px-4">Send</button>
  </form>

  <script type="module">
    import { api } from '/app.js';

    window.messagesApp = function () {
      return {
        matchId: new URLSearchParams(window.location.search).get('matchId'),
        messages: [],
        draft: '',
        init() {
          this.load();
        },
        async load() {
          const res = await api.messages(this.matchId);
          this.messages = res.messages;
        },
        async send() {
          if (!this.draft.trim()) return;
          await api.sendMessage(this.matchId, this.draft);
          this.draft = '';
          await this.load();
        },
      };
    };
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
</body>
</html>
```

- [ ] **Step 9: Write `public/settings.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wavelengthz — Settings</title>
  <link rel="stylesheet" href="/tailwind.css" />
</head>
<body class="min-h-screen bg-neutral-950 text-neutral-50 p-4" x-data="settingsApp()">
  <h1 class="text-2xl font-semibold mb-4">Settings</h1>

  <form class="max-w-md flex flex-col gap-4" @submit.prevent="updateDistance()">
    <label class="flex flex-col gap-1">
      <span>Max distance (km): <span x-text="maxDistanceKm"></span></span>
      <input type="range" min="5" max="200" x-model.number="maxDistanceKm" />
    </label>
    <button type="submit" class="bg-neutral-800 rounded p-2">Save</button>
  </form>

  <button class="mt-6 text-neutral-400 underline" @click="logout()">Log out</button>

  <div class="mt-8 border-t border-neutral-800 pt-4">
    <button class="text-red-400 underline" @click="confirmingDelete = true" x-show="!confirmingDelete">
      Delete my account
    </button>
    <div x-show="confirmingDelete" class="flex flex-col gap-2">
      <p role="alert">This deletes your account. Are you sure?</p>
      <div class="flex gap-2">
        <button class="bg-red-600 rounded px-3 py-1" @click="deleteAccount()">Yes, delete</button>
        <button class="bg-neutral-800 rounded px-3 py-1" @click="confirmingDelete = false">Cancel</button>
      </div>
    </div>
  </div>

  <script type="module">
    import { api } from '/app.js';

    window.settingsApp = function () {
      return {
        maxDistanceKm: 80,
        confirmingDelete: false,
        async updateDistance() {
          const me = await api.me();
          await api.onboard({
            date_of_birth: me.user.date_of_birth,
            location_label: me.user.location_label,
            lat: me.user.lat,
            lng: me.user.lng,
            max_distance_km: this.maxDistanceKm,
          });
        },
        async logout() {
          await fetch('/logout', { method: 'POST', credentials: 'include' });
          window.location.href = '/login';
        },
        async deleteAccount() {
          await api.deleteAccount();
          window.location.href = '/';
        },
      };
    };
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
</body>
</html>
```

- [ ] **Step 10: Write `public/manifest.json`**

```json
{
  "name": "Wavelengthz",
  "short_name": "Wavelengthz",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a0a0a",
  "theme_color": "#0a0a0a",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

Note: `/icons/icon-192.png` and `/icons/icon-512.png` are design assets (app icon artwork), not code — supply real PNGs at those paths before shipping; they're outside this plan's scope the same way `legal/privacy-policy.md`'s copy is (Task 18 creates the legal doc placeholder files, not their legal content).

- [ ] **Step 11: Write `public/sw.js`**

```javascript
const CACHE_NAME = 'wavelengthz-shell-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/swipe.js',
  '/tailwind.css',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
```

Also add, in `public/index.html`'s module script (append after the `deckApp` definition):

```javascript
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
```

- [ ] **Step 12: Commit**

```bash
git add public/app.js public/onboarding.html public/history.html public/matches.html public/messages.html public/settings.html public/manifest.json public/sw.js public/index.html test/public/app.history.test.ts
git commit -m "feat: add onboarding/history/matches/messages/settings pages and PWA shell"
```

---

### Task 18: Rate limiting, error tracking, and operational docs

**Files:**
- Create: `src/lib/rateLimit.ts`
- Create: `src/lib/sentry.ts`
- Modify: `src/index.ts` (global rate-limit + error-reporting middleware)
- Modify: `wrangler.toml` (add KV namespace for rate limiting)
- Create: `legal/privacy-policy.md`
- Create: `legal/terms-of-service.md`
- Create: `README.md`
- Test: `test/lib/rateLimit.test.ts`
- Test: `test/lib/sentry.test.ts`
- Test: `test/index.middleware.test.ts`

**Interfaces:**
- Consumes: `router` (Task 1).
- Produces: `checkRateLimit(kv: KVNamespace, key: string, limit: number, windowSeconds: number): Promise<boolean>` from `src/lib/rateLimit.ts` — `true` if the request is allowed, `false` if the caller is over the limit for the current window.
- Produces: `reportError(env: Env, error: unknown, context: { path: string }): Promise<void>` from `src/lib/sentry.ts` — POSTs a minimal Sentry envelope to `env.SENTRY_DSN`'s ingest endpoint; never throws itself (a Sentry outage must not break the response path).
- Produces: `src/index.ts`'s exported `fetch` wraps `router.fetch` in try/catch (reports to Sentry, returns a generic 500 on uncaught errors) and applies two rate limits ahead of routing: general `120/60s` per client IP across all `/api/*`, and a stricter `30/60s` per client IP specifically on `/api/swipe/*` — both return `429` with `{ error: 'rate_limited' }` when exceeded.
- Global Constraint addition: `SENTRY_DSN` is a Worker var/secret; `RATE_LIMIT_KV` is a new KV namespace binding (production + `env.test`).

- [ ] **Step 1: Write the failing test for `checkRateLimit`**

```typescript
// test/lib/rateLimit.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit } from '../../src/lib/rateLimit';

beforeEach(async () => {
  const list = await env.RATE_LIMIT_KV.list();
  await Promise.all(list.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
});

describe('checkRateLimit', () => {
  it('allows requests under the limit', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await checkRateLimit(env.RATE_LIMIT_KV, 'ip-1', 5, 60)).toBe(true);
    }
  });

  it('blocks the request that exceeds the limit', async () => {
    for (let i = 0; i < 3; i++) {
      await checkRateLimit(env.RATE_LIMIT_KV, 'ip-2', 3, 60);
    }
    expect(await checkRateLimit(env.RATE_LIMIT_KV, 'ip-2', 3, 60)).toBe(false);
  });

  it('tracks separate keys independently', async () => {
    for (let i = 0; i < 3; i++) await checkRateLimit(env.RATE_LIMIT_KV, 'ip-a', 3, 60);
    expect(await checkRateLimit(env.RATE_LIMIT_KV, 'ip-b', 3, 60)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/rateLimit.test.ts`
Expected: FAIL — `src/lib/rateLimit.ts` does not exist, and `RATE_LIMIT_KV` isn't bound yet.

- [ ] **Step 3: Add the KV namespace binding to `wrangler.toml`**

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "REPLACE_WITH_REAL_ID_AFTER_wrangler_kv_namespace_create"

[[env.test.kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "test-kv-id"
```

- [ ] **Step 4: Write `src/lib/rateLimit.ts`**

```typescript
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const storageKey = `ratelimit:${key}:${bucket}`;

  const current = Number((await kv.get(storageKey)) ?? '0');
  if (current >= limit) return false;

  await kv.put(storageKey, String(current + 1), { expirationTtl: windowSeconds });
  return true;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/lib/rateLimit.test.ts`
Expected: PASS (3/3)

- [ ] **Step 6: Write the failing test for `reportError`**

```typescript
// test/lib/sentry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { reportError } from '../../src/lib/sentry';

describe('reportError', () => {
  it('posts to the Sentry envelope endpoint derived from the DSN', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const env = { SENTRY_DSN: 'https://publickey@o123.ingest.sentry.io/456' } as any;
    await reportError(env, new Error('boom'), { path: '/api/me' });

    expect(fetchMock).toHaveBeenCalled();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('o123.ingest.sentry.io');
    expect(url).toContain('/api/456/envelope/');

    vi.unstubAllGlobals();
  });

  it('never throws even when Sentry itself is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const env = { SENTRY_DSN: 'https://publickey@o123.ingest.sentry.io/456' } as any;
    await expect(reportError(env, new Error('boom'), { path: '/x' })).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('is a no-op when SENTRY_DSN is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await reportError({} as any, new Error('boom'), { path: '/x' });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/lib/sentry.test.ts`
Expected: FAIL — `src/lib/sentry.ts` does not exist.

- [ ] **Step 8: Write `src/lib/sentry.ts`**

```typescript
function parseDsn(dsn: string): { ingestHost: string; projectId: string; publicKey: string } | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace('/', '');
    return { ingestHost: url.host, projectId, publicKey: url.username };
  } catch {
    return null;
  }
}

export async function reportError(env: Env, error: unknown, context: { path: string }): Promise<void> {
  const dsn = env.SENTRY_DSN;
  if (!dsn) return;

  const parsed = parseDsn(dsn);
  if (!parsed) return;

  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  const envelopeHeader = JSON.stringify({ event_id: crypto.randomUUID(), sent_at: new Date().toISOString() });
  const itemHeader = JSON.stringify({ type: 'event' });
  const item = JSON.stringify({
    message,
    level: 'error',
    extra: { stack, path: context.path },
    timestamp: Date.now() / 1000,
  });
  const body = `${envelopeHeader}\n${itemHeader}\n${item}`;

  try {
    await fetch(`https://${parsed.ingestHost}/api/${parsed.projectId}/envelope/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsed.publicKey}`,
      },
      body,
    });
  } catch {
    // Sentry being unreachable must never break the request path.
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/lib/sentry.test.ts`
Expected: PASS (3/3)

- [ ] **Step 10: Write the failing test for the global middleware**

```typescript
// test/index.middleware.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applySchema } from './apply-schema';
import worker from '../src/index';

beforeEach(async () => {
  await applySchema(env.DB);
  const list = await env.RATE_LIMIT_KV.list();
  await Promise.all(list.keys.map((k) => env.RATE_LIMIT_KV.delete(k.name)));
});

describe('global middleware', () => {
  it('rate-limits swipe endpoints tighter than general /api/* traffic', async () => {
    const makeSwipeReq = () =>
      new Request('http://localhost/api/swipe/music', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '1.2.3.4', 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: 'artist', item_id: 'a1', direction: 'left' }),
      });

    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      const res = await worker.fetch(makeSwipeReq(), env, {} as ExecutionContext);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('returns a generic 500 and does not leak error internals when a route throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('downstream Spotify outage'); }));
    const req = new Request('http://localhost/login', { headers: { 'CF-Connecting-IP': '9.9.9.9' } });
    // /login itself doesn't call fetch, so force a throwing path via callback with a broken code exchange:
    const callbackReq = new Request('http://localhost/callback?code=x&state=y', {
      headers: { Cookie: 'wl_oauth_state=y', 'CF-Connecting-IP': '9.9.9.8' },
    });
    const res = await worker.fetch(callbackReq, env, {} as ExecutionContext);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('downstream Spotify outage');
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 11: Run test to verify it fails**

Run: `npx vitest run test/index.middleware.test.ts`
Expected: FAIL — no rate limiting or error-wrapping yet.

- [ ] **Step 12: Wire middleware into `src/index.ts`**

Replace the `fetch` export with:

```typescript
import { checkRateLimit } from './lib/rateLimit';
import { reportError } from './lib/sentry';

const GENERAL_LIMIT = { limit: 120, windowSeconds: 60 };
const SWIPE_LIMIT = { limit: 30, windowSeconds: 60 };

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

    if (url.pathname.startsWith('/api/')) {
      const generallyAllowed = await checkRateLimit(env.RATE_LIMIT_KV, `general:${ip}`, GENERAL_LIMIT.limit, GENERAL_LIMIT.windowSeconds);
      if (!generallyAllowed) return Response.json({ error: 'rate_limited' }, { status: 429 });
    }

    if (url.pathname.startsWith('/api/swipe/')) {
      const swipeAllowed = await checkRateLimit(env.RATE_LIMIT_KV, `swipe:${ip}`, SWIPE_LIMIT.limit, SWIPE_LIMIT.windowSeconds);
      if (!swipeAllowed) return Response.json({ error: 'rate_limited' }, { status: 429 });
    }

    try {
      return await router.fetch(request, env, ctx);
    } catch (error) {
      ctx.waitUntil(reportError(env, error, { path: url.pathname }));
      return new Response('Internal Server Error', { status: 500 });
    }
  },
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(purgeExpiredDeletions(env, GRACE_PERIOD_MS, Date.now()).then(() => undefined));
  },
};
```

- [ ] **Step 13: Run test to verify it passes**

Run: `npx vitest run test/index.middleware.test.ts`
Expected: PASS (2/2)

- [ ] **Step 14: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — every test file from Tasks 1-18 green.

- [ ] **Step 15: Write `legal/privacy-policy.md` and `legal/terms-of-service.md`**

```markdown
<!-- legal/privacy-policy.md -->
# Privacy Policy (DRAFT — not legal advice, review with counsel before launch)

This document is a placeholder required by docs/PLAN.md §8 and by Spotify's
Developer Terms, which condition API access on a published privacy policy.
Real legal copy — data collected (Spotify profile, top artists/tracks,
location, photos, messages), retention (see the account-deletion grace
period in Task 15), third parties (Spotify, Resend, Sentry, Cloudflare),
and user rights (GDPR/CCPA deletion and export) — must be drafted and
reviewed before any real user signs up.
```

```markdown
<!-- legal/terms-of-service.md -->
# Terms of Service (DRAFT — not legal advice, review with counsel before launch)

This document is a placeholder required by docs/PLAN.md §8. Real terms —
eligibility (18+, enforced in-app per Task 6), acceptable use, the
block/report/unmatch flows (Task 14), account termination, and dispute
resolution — must be drafted and reviewed before any real user signs up.
```

- [ ] **Step 16: Write `README.md`**

```markdown
# Wavelengthz

Music-taste matching app. Spotify OAuth login, two swipe modes (people +
music), blended match scoring, messaging, trust & safety, and transactional
email — built on Cloudflare Workers + D1 + R2. Full design in `docs/PLAN.md`.

## Setup

1. `npm install`
2. `wrangler d1 create wavelengthz-db` — copy the returned `database_id` into `wrangler.toml`
3. `wrangler kv namespace create RATE_LIMIT_KV` — copy the returned `id` into `wrangler.toml`
4. `wrangler r2 bucket create wavelengthz-photos`
5. Apply the schema: `wrangler d1 execute wavelengthz-db --file=src/db/schema.sql`
6. Set secrets:
   ```
   wrangler secret put SPOTIFY_CLIENT_ID
   wrangler secret put SPOTIFY_CLIENT_SECRET
   wrangler secret put TOKEN_ENCRYPTION_KEY   # 32 random bytes, base64-encoded
   wrangler secret put SEED_SECRET
   wrangler secret put R2_ACCOUNT_ID
   wrangler secret put R2_ACCESS_KEY_ID
   wrangler secret put R2_SECRET_ACCESS_KEY
   wrangler secret put RESEND_API_KEY
   wrangler secret put SENTRY_DSN
   ```
7. `npm run build:css` to build Tailwind's output before first run/deploy.
8. `wrangler dev` for local development.
9. Seed the catalog once, locally or after deploy: `curl -X POST https://<your-worker>/internal/seed -H "X-Seed-Secret: <value>"`.
10. `wrangler deploy` to ship.

## Operational checklist before real users (docs/PLAN.md §14)

- [ ] Confirm Cloudflare D1 point-in-time recovery is enabled for the production database in the dashboard — it is not on by default.
- [ ] Confirm the `wavelengthz` domain is registered (docs/PLAN.md §16).
- [ ] Have `legal/privacy-policy.md` and `legal/terms-of-service.md` reviewed by counsel and replace the draft placeholders.
- [ ] Run a Lighthouse mobile pass (performance + accessibility) against the deployed swipe UI.
- [ ] Supply real PWA icon artwork at `public/icons/icon-192.png` and `public/icons/icon-512.png`.
- [ ] Deferred from docs/PLAN.md §11: photos are served as-uploaded via `GET /photos/:id` (Task 7) without WebP/AVIF transcoding or per-breakpoint resizing. Wire up Cloudflare Images (or a `/cdn-cgi/image/` resize on the `/photos/:id` route) before real-user launch.

## Testing

`npx vitest run` — runs the full suite against `@cloudflare/vitest-pool-workers` (simulated D1/R2/KV bindings, no real Cloudflare account needed).
```

- [ ] **Step 17: Commit**

```bash
git add src/lib/rateLimit.ts src/lib/sentry.ts src/index.ts wrangler.toml legal/privacy-policy.md legal/terms-of-service.md README.md test/lib/rateLimit.test.ts test/lib/sentry.test.ts test/index.middleware.test.ts
git commit -m "feat: add rate limiting, Sentry error reporting, and operational docs"
```

---

---

### Task 19: Periodic catalog growth from user listening data

**Files:**
- Create: `src/db/catalogRefresh.ts`
- Modify: `src/index.ts` (branch the `scheduled` handler on `event.cron`)
- Modify: `wrangler.toml` (add a second cron schedule)
- Test: `test/db/catalogRefresh.test.ts`

**Interfaces:**
- Consumes: `getClientCredentialsToken`, `fetchArtistById` (Task 5/9).
- Produces: `refreshCatalogFromProfiles(env: Env): Promise<{ artistsAdded: number }>` from `src/db/catalogRefresh.ts` — scans every cached `music_profiles.top_artists`, and for any artist id not yet in the `artists` table, fetches it from Spotify and inserts it (`source='spotify_search'`, `added_by_user_id=null`, `approved=1`). This implements docs/PLAN.md §4's "Growth via periodic refresh," which the scheduled job added in Task 15 did not cover (that job only handles account-deletion purging).
- The `scheduled` handler now branches on `event.cron`: the existing daily schedule runs `purgeExpiredDeletions`, a new weekly schedule runs `refreshCatalogFromProfiles`.

- [ ] **Step 1: Write the failing test for `refreshCatalogFromProfiles`**

```typescript
// test/db/catalogRefresh.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { applySchema } from '../apply-schema';
import { refreshCatalogFromProfiles } from '../../src/db/catalogRefresh';

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM music_profiles; DELETE FROM artists; DELETE FROM users;');
  await env.DB.prepare(
    `INSERT INTO users (id, spotify_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
     VALUES ('u1', 'sp1', 'a', 'r', 9999999999999, 1000, 1000)`
  ).run();
  await env.DB.prepare(`INSERT INTO artists (id, name, genres, source, approved, created_at) VALUES ('already-known', 'Known Artist', '[]', 'seed', 1, 1000)`).run();
});

describe('refreshCatalogFromProfiles', () => {
  it('adds only the artists missing from the catalog, fetching each exactly once', async () => {
    await env.DB.prepare(
      `INSERT INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at)
       VALUES ('u1', ?, '[]', '[]', 'medium_term', 1000)`
    ).bind(JSON.stringify([{ artist_id: 'already-known', rank: 1 }, { artist_id: 'new-artist', rank: 2 }])).run();

    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = input.toString();
      if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'cc' }), { status: 200 });
      if (url.includes('/v1/artists/new-artist')) {
        return new Response(JSON.stringify({ id: 'new-artist', name: 'New Artist', genres: ['indie'], images: [], popularity: 40 }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshCatalogFromProfiles(env as any);

    expect(result.artistsAdded).toBe(1);
    const row = await env.DB.prepare('SELECT * FROM artists WHERE id = ?').bind('new-artist').first<any>();
    expect(row.source).toBe('spotify_search');
    expect(fetchMock.mock.calls.some((c) => c[0].toString().includes('/v1/artists/already-known'))).toBe(false);

    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/catalogRefresh.test.ts`
Expected: FAIL — `src/db/catalogRefresh.ts` does not exist.

- [ ] **Step 3: Write `src/db/catalogRefresh.ts`**

```typescript
import { getClientCredentialsToken, fetchArtistById } from '../lib/spotify';

export async function refreshCatalogFromProfiles(env: Env): Promise<{ artistsAdded: number }> {
  const profiles = await env.DB.prepare('SELECT top_artists FROM music_profiles').all<{ top_artists: string }>();

  const candidateIds = new Set<string>();
  for (const row of profiles.results) {
    const artists: Array<{ artist_id: string }> = JSON.parse(row.top_artists);
    for (const artist of artists) candidateIds.add(artist.artist_id);
  }

  let token: string | null = null;
  let artistsAdded = 0;

  for (const artistId of candidateIds) {
    const existing = await env.DB.prepare('SELECT 1 FROM artists WHERE id = ?').bind(artistId).first();
    if (existing) continue;

    if (!token) token = await getClientCredentialsToken(env);
    const artist = await fetchArtistById(token, artistId);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO artists (id, name, genres, image_url, popularity, source, added_by_user_id, approved, created_at)
       VALUES (?, ?, ?, ?, ?, 'spotify_search', NULL, 1, ?)`
    ).bind(artist.id, artist.name, JSON.stringify(artist.genres ?? []), artist.images?.[0]?.url ?? null, artist.popularity ?? null, Date.now()).run();
    artistsAdded += 1;
  }

  return { artistsAdded };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/catalogRefresh.test.ts`
Expected: PASS (1/1)

- [ ] **Step 5: Add the weekly cron schedule to `wrangler.toml`**

```toml
[triggers]
crons = ["0 3 * * *", "0 4 * * 0"]
```

- [ ] **Step 6: Branch the `scheduled` handler in `src/index.ts`**

Replace the `scheduled` key in the default export with:

```typescript
  scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    if (event.cron === '0 4 * * 0') {
      ctx.waitUntil(refreshCatalogFromProfiles(env).then(() => undefined));
    } else {
      ctx.waitUntil(purgeExpiredDeletions(env, GRACE_PERIOD_MS, Date.now()).then(() => undefined));
    }
  },
```

Add the import alongside the existing `purgeExpiredDeletions` import:

```typescript
import { refreshCatalogFromProfiles } from './db/catalogRefresh';
```

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — every test file from Tasks 1-19 green.

- [ ] **Step 8: Commit**

```bash
git add src/db/catalogRefresh.ts src/index.ts wrangler.toml test/db/catalogRefresh.test.ts
git commit -m "feat: add periodic catalog growth from cached user listening data"
```

---

## Post-plan manual steps (not part of the automated task loop)

These require human action outside the codebase and are listed here so nothing from docs/PLAN.md §16 is silently dropped:

- Register a Spotify Developer app and obtain `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`.
- Create the actual Cloudflare resources (`wrangler d1 create`, `wrangler kv namespace create`, `wrangler r2 bucket create`) and paste the real IDs into `wrangler.toml` (Task 1/18 leave placeholder IDs by design).
- Sign up for Resend/Postmark and Sentry, obtain their keys.
- Supply real PWA icon artwork.
- Have `legal/privacy-policy.md` and `legal/terms-of-service.md` reviewed by counsel.
- Verify D1 point-in-time recovery is enabled in the Cloudflare dashboard.

---

## Post-Launch Changes

Everything below happened after Task 19 merged, driven by real local-dev usage and bug reports rather than the formal subagent-driven-development task loop. Organized by theme, not chronologically. File paths are the current, post-change locations.

### Local-dev environment fixes

- **Spotify OAuth `redirect_uri`**: must be `http://127.0.0.1:8787/callback` — Spotify allows plain HTTP only for the literal loopback IP, not the `localhost` hostname. Set in `wrangler.toml`'s `[vars]`.
- **Service worker was breaking OAuth login** ("Invalid OAuth state" with nothing logged server-side): `public/sw.js` intercepted the `/login` navigation and re-issued it via `fetch()`, which follows the Spotify redirect *internally* instead of letting the browser perform a real top-level navigation — this silently broke the state-cookie round-trip. Fixed by excluding `/login`, `/callback`, `/logout` from the service worker's fetch handler entirely (a service worker has no legitimate role in a third-party OAuth handshake — nothing to cache).
- **Seed catalog pagination**: Spotify's real `/v1/search` max `limit` is 10, not 50 — `SEARCH_PAGE_SIZE` in `src/db/seed.ts`.
- **Spotify's "Get Artist's Top Tracks" endpoint now 403s** for this app (moved behind Extended Quota Mode access, verified directly against the live API with both a client-credentials and a real user token). `src/db/seed.ts` and the artist-profile route (`src/routes/catalog.ts`) now use track search by artist name instead (`searchTracksByArtistName` in `src/lib/spotify.ts`) — this was silently broken all along, producing 0 tracks despite artists seeding successfully.
- **Music-mode candidate images**: `GET /api/candidates/music` now selects and returns `imageUrl` (previously omitted entirely).
- **Artist candidates with no photo** are excluded from `/api/candidates/music` (broken-looking swipe cards otherwise).
- **Global unhandled-error logging**: `src/index.ts`'s catch-all now `console.error`s before reporting to Sentry, since local dev's Sentry DSN is an unmonitored placeholder — errors were previously invisible in the `wrangler dev` terminal.
- **All 12 Spotify API wrapper functions** (`src/lib/spotify.ts`) now include the response body in thrown errors, not just the HTTP status.
- **R2 CORS**: a CORS policy was added to the `wavelengthz-photos` bucket during initial photo-upload debugging. It's no longer load-bearing (see "Photo upload architecture rewrite" below) but was left in place as harmless.

### Design system and navigation

- Full visual identity: coral-to-violet brand gradient, Manrope type, consistent buttons/cards/inputs (`public/styles.css`, `tailwind.config.js`) — the app previously had no styling beyond raw Tailwind utility classes.
- Shared bottom tab nav (Deck/History/Matches/Settings) + gradient wordmark header (`public/nav.js`), injected client-side into every page except onboarding (a one-time gate, not a nav destination).
- Redesigned swipe deck card (photo with gradient text scrim), action buttons, and every page's layout to match.

### Auth-aware UI

- `public/auth.js`: `getAuthedUser()` (checks `/api/me`, treats 401 as logged-out) and `requireAuth()` (redirects to `/login` if logged out).
- The deck (`/`) shows a login card instead of a broken deck when logged out; every other protected page (history, matches, settings, messages, artist, match, profile, onboarding) redirects to `/login` via `requireAuth()`.
- **Logout fixed**: redirects to `/` instead of `/login` — redirecting to `/login` immediately re-triggers Spotify OAuth, which silently re-authenticates the same account if Spotify still has an active browser session, making a successful logout look like a no-op. Also now checks `res.ok` before declaring success (the fetch itself doesn't throw on a non-2xx response).

### Schema changes since Task 1

- `users.spotify_avatar_url` (nullable `TEXT`) — imported from Spotify's own profile photo on every login (insert and refresh). Shown only in Settings as an account-identity indicator; **never** copied into `user_photos` or used as a match-facing photo.
- `artists.genres` changed from a JSON array (`["indie","rock"]`) to a JSON object map (`{"indie":true,"rock":true}`) for O(1) genre-membership checks. Conversion helpers in `src/lib/genres.ts` (`genresToObject`/`genresFromRow`); API responses still expose genres as a plain array, only the DB storage format changed.
- `user_genre_affinity` (single `like_count` column) replaced by **`user_genres`** (`artist_count`/`track_count` split), same auto-increment-on-right-swipe/decrement-on-change-to-left semantics, now also triggered by the History "Change" toggle (see Bug fixes).
- New **`genres`** table: catalog-wide `artist_count`/`track_count` per genre, auto-incremented whenever a new artist/track actually lands in the catalog (`src/lib/genreCatalog.ts`), wired into every catalog-write site: seeding, the weekly catalog-refresh cron, catalog search-and-add, and the artist-profile upsert path.
- **Known limitation:** Spotify's API no longer returns genre data on artist objects at all, on either `/v1/search` or `/v1/artists/{id}` (verified directly against the live API). Both genre tables are correctly wired but will stay effectively empty until Spotify restores this data or a different genre source is added — this is a platform limitation, not a bug here.

### New features

- **History pagination and filtering** — Previous/Next controls plus a liked/passed filter on `/history`, backed by a `?direction=` param on `GET /api/swipes/:mode`. Logic extracted into a testable `public/history.js`.
- **Match detail page** (`/match?id=`) — the other participant plus music overlap (shared right-swiped artists/tracks, shared genres), computed by the shared `computeMusicOverlap` helper (`src/lib/musicOverlap.ts`) and served by `GET /api/matches/:id`.
- **Person profile pages** (`/profile?id=`) — full photo set, bio, distance, "Likes you"/"Matched" badges, and the same music overlap. Viewable for a current candidate *or* an active match (not gated to matches only — the point of a music-first dating app is surfacing "why you might match" before someone decides to swipe). Safety-scoped via `isBlockedEitherDirection` (`src/lib/blocks.ts`) and soft-delete/onboarding checks, served by `GET /api/people/:id/profile`. Reachable from an info icon in the deck's People-mode action row and a "View full profile" link on the match page.
- **Artist profile pages** (`/artist?id=`) — an artist's top tracks (via the track-search fallback above) with per-track like/pass, backed by `GET /api/artists/:id` (upserts the artist and its tracks into the catalog on first view). Reachable via a magnifying-glass search modal on the music deck (debounced, 3+ characters, `public/search.js`) using the existing merged local+Spotify `GET /api/artists/search`.
- **Photo management in Settings** — up to 10 photos (enforced client- and server-side), not just during onboarding. Shared upload/remove module (`public/photos.js`) used by both onboarding and Settings.
- **Hard-delete admin endpoint** — `POST /internal/users/:id/delete` (same `X-Seed-Secret` header gate as `/internal/seed`), looks up by internal id or Spotify id, reuses the existing `hardDeleteUser`. For wiping a local test account and its full history to re-test onboarding from scratch.

### Bug fixes

- **Photo upload architecture rewrite**: uploads previously went straight from the browser to R2's real S3-compatible endpoint via a Worker-issued presigned URL (the original Task 7 design, and a stated Global Constraint above), while reads (`GET /photos/:id`) went through the `env.PHOTOS` Workers binding — in local dev, two entirely separate storage backends. An upload could "succeed" into the real bucket and still 404 when the app tried to display it. Fixed by routing upload bytes directly through the Worker: `POST /api/photos` now accepts the raw file body and calls `env.PHOTOS.put()` itself, so writes and reads always use the same binding in every environment. This also removes the R2 CORS dependency entirely (no more direct cross-origin browser-to-R2 request). `src/lib/r2.ts` (SigV4 presigned-URL signing) was removed as dead code.
- **Matches silently not created after a mutual like via History**: `PATCH /api/swipes/people/:id` (the History "Change" toggle) updated a swipe's direction but never checked whether that completed a mutual right-swipe, so changing a past decision to "right" (as opposed to a fresh right-swipe through the deck) silently skipped match creation. Fixed, with regression tests. The identical bug existed in the music-swipe toggle (`PATCH /api/swipes/music/:id` never updated genre affinity) — fixed the same way.
