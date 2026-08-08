# Google Sign-On Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google as a second, equal login option alongside Spotify — a `/login` choice page, symmetric email-based auto-linking, a "Connect Spotify" action in Settings for Google-only users, and an `/api/me` guard for users with no linked music source. No schema migration needed.

**Architecture:** A new `src/lib/google.ts` mirrors `src/lib/spotify.ts`'s OAuth shape. Today's `/login` route (host-canonicalization + state cookie + redirect) moves to `/login/spotify` and gains an `intent=connect` variant; `/login/google` is its simpler Google equivalent (no allowed-hosts support). `/callback` (Spotify, existing) and the new `/callback/google` both write through `auth_identities`/`music_source_tokens` (built in Phase 1), sharing the same email-based auto-link and reactivation logic. `/login` itself becomes a static page served via the existing `ASSETS` fallback, not a route handler.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, itty-router, Alpine.js, Vitest + `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Both providers are equal choices; neither is primary. `/login` becomes a static choice page (`public/login.html`) with no route handler — served via the existing `ASSETS` binding fallback (`router.all('*', ...)` in `src/index.ts`).
- No Google access/refresh tokens are ever persisted — identity only. No `music_source_tokens` row is ever created for `provider = 'google'`.
- Auto-link by email is symmetric: both `/callback` (Spotify) and `/callback/google` fall back to a `users.email` lookup when no same-provider identity match exists, before creating a new user. Spotify's email is treated as trustworthy for this purpose (no explicit verification flag exists in its API, but Spotify requires verified email at signup on their end); Google's requires `email_verified: true`. A match found via soft-deleted user reactivates them (`deleted_at = NULL`), matching the existing same-provider reactivation behavior.
- A new Google-only user gets `users.spotify_id` set to their own `users.id` (a guaranteed-unique placeholder), per Phase 1's spec guidance — never a duplicate or null value in that still-`UNIQUE NOT NULL` column.
- "Connect Spotify" (Settings, for a Google-only user) reuses `/login/spotify` with `?intent=connect`, which sets an additional `wl_oauth_intent=connect` cookie. `/callback` checks this cookie plus an active session to link the new identity onto the **current** user instead of running login/signup logic, rejecting with a query-param error if that Spotify account is already claimed by someone else.
- `public/sw.js`'s `BYPASS_PATHS` must include every new OAuth-adjacent path (`/login/spotify`, `/login/google`, `/callback/google`) — a service worker intercepting an OAuth redirect has already broken the state-cookie round-trip once in this codebase's history.
- Not building: `SPOTIFY_ALLOWED_HOSTS`-style Cloudflare Tunnel support for Google, or a symmetric "Connect Google" action.
- Full suite (`npx vitest run`) and `npx tsc --noEmit` clean is the acceptance bar for every task.

---

### Task 1: `src/lib/google.ts`

**Files:**
- Create: `src/lib/google.ts`
- Create: `test/lib/google.test.ts`
- Modify: `src/env.d.ts`
- Modify: `wrangler.toml`

**Interfaces:**
- Produces: `buildGoogleAuthUrl(state: string, env: Env, redirectUri?: string): string`, `exchangeGoogleCode(code: string, env: Env, redirectUri?: string): Promise<{ access_token: string; expires_in: number }>`, `fetchGoogleProfile(accessToken: string): Promise<{ sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }>` from `src/lib/google.ts`.
- Produces: `env.GOOGLE_CLIENT_ID: string`, `env.GOOGLE_CLIENT_SECRET: string` (secrets), `env.GOOGLE_REDIRECT_URI: string` (plain var).

- [ ] **Step 1: Add `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` to `src/env.d.ts`**

Add to both the top-level `Env` interface and the `Cloudflare.Env` interface (same treatment as `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`):

```typescript
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
```

- [ ] **Step 2: Add `GOOGLE_REDIRECT_URI` to `wrangler.toml`**

In the `[vars]` block:

```toml
GOOGLE_REDIRECT_URI = "http://127.0.0.1:8787/callback/google"
```

In the `[env.test.vars]` block, add:

```toml
GOOGLE_REDIRECT_URI = "http://127.0.0.1:8787/callback/google"
GOOGLE_CLIENT_ID = "test-google-client-id"
GOOGLE_CLIENT_SECRET = "test-google-client-secret"
```

Run `npx wrangler types` afterward so the generated `Env`/`Cloudflare.Env` interfaces include `GOOGLE_REDIRECT_URI`.

- [ ] **Step 3: Write the failing tests**

```typescript
// test/lib/google.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildGoogleAuthUrl, exchangeGoogleCode, fetchGoogleProfile } from '../../src/lib/google';

const env = {
  GOOGLE_CLIENT_ID: 'client123',
  GOOGLE_CLIENT_SECRET: 'secret456',
  GOOGLE_REDIRECT_URI: 'http://localhost:8787/callback/google',
} as any;

describe('buildGoogleAuthUrl', () => {
  it('builds a Google authorize URL with client id, redirect uri, scope, and state', () => {
    const url = new URL(buildGoogleAuthUrl('state-abc', env));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/callback/google');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('scope')).toContain('openid');
    expect(url.searchParams.get('scope')).toContain('email');
    expect(url.searchParams.get('scope')).toContain('profile');
  });

  it('uses a supplied redirect_uri override instead of the env default', () => {
    const url = new URL(buildGoogleAuthUrl('state-abc', env, 'https://other.example.com/callback/google'));
    expect(url.searchParams.get('redirect_uri')).toBe('https://other.example.com/callback/google');
  });
});

describe('exchangeGoogleCode', () => {
  it('posts client_id, client_secret, code, and redirect_uri to the token endpoint', async () => {
    let sentBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        expect(input.toString()).toBe('https://oauth2.googleapis.com/token');
        sentBody = String(init?.body ?? '');
        return new Response(JSON.stringify({ access_token: 'gtoken', expires_in: 3600 }), { status: 200 });
      })
    );

    const result = await exchangeGoogleCode('auth-code', env);
    expect(result.access_token).toBe('gtoken');
    const params = new URLSearchParams(sentBody);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('auth-code');
    expect(params.get('redirect_uri')).toBe('http://localhost:8787/callback/google');
    expect(params.get('client_id')).toBe('client123');
    expect(params.get('client_secret')).toBe('secret456');

    vi.unstubAllGlobals();
  });

  it('throws with the response body on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid_grant', { status: 400 })));
    await expect(exchangeGoogleCode('bad-code', env)).rejects.toThrow(/400/);
    vi.unstubAllGlobals();
  });
});

describe('fetchGoogleProfile', () => {
  it('returns sub, email, email_verified, name, and picture from the userinfo response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        expect(input.toString()).toBe('https://openidconnect.googleapis.com/v1/userinfo');
        return new Response(
          JSON.stringify({ sub: 'google-123', email: 'a@b.com', email_verified: true, name: 'A B', picture: 'https://img.example/pic.jpg' }),
          { status: 200 }
        );
      })
    );

    const profile = await fetchGoogleProfile('gtoken');
    expect(profile.sub).toBe('google-123');
    expect(profile.email).toBe('a@b.com');
    expect(profile.email_verified).toBe(true);
    expect(profile.picture).toBe('https://img.example/pic.jpg');

    vi.unstubAllGlobals();
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    await expect(fetchGoogleProfile('bad-token')).rejects.toThrow(/401/);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/lib/google.test.ts`
Expected: FAIL — `src/lib/google.ts` does not exist.

- [ ] **Step 5: Write `src/lib/google.ts`**

```typescript
export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
}

const SCOPES = ['openid', 'email', 'profile'].join(' ');

export function buildGoogleAuthUrl(state: string, env: Env, redirectUri: string = env.GOOGLE_REDIRECT_URI): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

// Google's token endpoint takes client_id/client_secret in the request body
// (form-encoded), not a Basic auth header -- this is Google's documented
// standard, unlike Spotify's Basic-auth convention in src/lib/spotify.ts.
export async function exchangeGoogleCode(
  code: string,
  env: Env,
  redirectUri: string = env.GOOGLE_REDIRECT_URI
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function fetchGoogleProfile(
  accessToken: string
): Promise<{ sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }> {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google profile fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/lib/google.test.ts`
Expected: PASS (7/7)

- [ ] **Step 7: Commit**

```bash
git add src/lib/google.ts test/lib/google.test.ts src/env.d.ts wrangler.toml worker-configuration.d.ts
git commit -m "feat: add Google OAuth library"
```

---

### Task 2: `insertTestUser` gains a `skipSpotify` option

**Files:**
- Modify: `test/helpers/createUser.ts`
- Modify: `test/helpers/createUser.test.ts`

**Interfaces:**
- Produces: `TestUserOverrides.skipSpotify?: boolean` — when true, `insertTestUser` creates only the `users` row (still with a placeholder `spotify_id`), no `auth_identities` or `music_source_tokens` rows. Simulates a Google-only user for later tasks' tests. Default (unset/false) is unchanged — every existing call site across the codebase is unaffected.

- [ ] **Step 1: Write the failing test**

Append to `test/helpers/createUser.test.ts`:

```typescript
describe('insertTestUser with skipSpotify', () => {
  it('creates only the users row, with no auth_identities or music_source_tokens rows', async () => {
    const id = await insertTestUser(env.DB, { skipSpotify: true });

    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<any>();
    expect(user).toBeTruthy();

    const identity = await env.DB.prepare('SELECT * FROM auth_identities WHERE user_id = ?').bind(id).first();
    expect(identity).toBeNull();

    const token = await env.DB.prepare('SELECT * FROM music_source_tokens WHERE user_id = ?').bind(id).first();
    expect(token).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/helpers/createUser.test.ts`
Expected: FAIL — `skipSpotify` is not recognized, both identity/token rows still get created.

- [ ] **Step 3: Update `test/helpers/createUser.ts`**

Add `skipSpotify?: boolean;` to the `TestUserOverrides` interface. Wrap the two `INSERT` calls after the `users` insert:

```typescript
  if (overrides.skipSpotify) return id;

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
```

(i.e. insert the `if (overrides.skipSpotify) return id;` line immediately after the existing `users` INSERT's `.run();`, before the `auth_identities` insert.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/helpers/createUser.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add test/helpers/createUser.ts test/helpers/createUser.test.ts
git commit -m "test: add skipSpotify option to insertTestUser for Google-only fixtures"
```

---

### Task 3: Login routing — `/login/spotify`, `/login/google`, `public/login.html`

**Files:**
- Modify: `src/routes/auth.ts`
- Create: `public/login.html`
- Modify: `public/index.html`
- Modify: `public/sw.js`
- Modify: `test/routes/auth.test.ts`

**Interfaces:**
- Consumes: `buildGoogleAuthUrl` (Task 1).
- Produces: `GET /login/spotify` (today's `/login` logic, unchanged, plus `?intent=connect` cookie support), `GET /login/google` (new). `/login` itself is no longer a route — served as a static page.

- [ ] **Step 1: Move `/login` to `/login/spotify`, add intent-cookie support, add `/login/google`**

In `src/routes/auth.ts`, add `getSessionUser` to the import from `../lib/session` (needed by Task 4, harmless to add now): `import { createSession, requestIsSecure, requestProtocol, getSessionUser } from '../lib/session';`. Add an import for the new library: `import { buildGoogleAuthUrl } from '../lib/google';`.

Replace `router.get('/login', async (request: IRequest, env: Env) => {` with `router.get('/login/spotify', async (request: IRequest, env: Env) => {` (the handler body is otherwise unchanged up through the `state`/`authUrl` lines). Replace the handler's final `return` statement:

```typescript
    const state = crypto.randomUUID();
    const authUrl = buildAuthUrl(state, env, callbackUrlForHost(requestProtocol(request), url.host));
    const secure = requestIsSecure(request);
    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl,
        'Set-Cookie': `wl_oauth_state=${state}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=600`,
      },
    });
  });
```

with:

```typescript
    const state = crypto.randomUUID();
    const authUrl = buildAuthUrl(state, env, callbackUrlForHost(requestProtocol(request), url.host));
    const secure = requestIsSecure(request);

    // ?intent=connect (from Settings' "Connect Spotify" action) marks this as
    // linking to the currently logged-in user rather than a fresh login --
    // /callback reads this cookie to decide which path to take.
    const headers = new Headers({ Location: authUrl });
    headers.append('Set-Cookie', `wl_oauth_state=${state}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=600`);
    if (url.searchParams.get('intent') === 'connect') {
      headers.append('Set-Cookie', `wl_oauth_intent=connect; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=600`);
    }
    return new Response(null, { status: 302, headers });
  });
```

Add a new route immediately after `/login/spotify`'s closing `});`:

```typescript
  router.get('/login/google', async (request: IRequest, env: Env) => {
    const state = crypto.randomUUID();
    const authUrl = buildGoogleAuthUrl(state, env);
    const secure = requestIsSecure(request);
    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl,
        'Set-Cookie': `wl_oauth_state=${state}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=600`,
      },
    });
  });
```

- [ ] **Step 2: Create `public/login.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Wavelengthz — Log in</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/tailwind.css" />
  <link rel="manifest" href="/manifest.json" />
</head>
<body class="min-h-screen bg-base text-neutral-50 flex items-center justify-center p-4">
  <div class="card flex w-full max-w-sm flex-col items-center gap-3 px-6 py-12 text-center">
    <span class="text-3xl">🎧</span>
    <p class="font-semibold text-neutral-100">Find your wavelength</p>
    <p class="text-sm text-neutral-400">Log in to start swiping on people and music.</p>
    <a href="/login/spotify" class="btn-primary mt-2 w-full">Continue with Spotify</a>
    <a href="/login/google" class="btn-secondary w-full">Continue with Google</a>
  </div>
</body>
</html>
```

(`btn-secondary` is already defined in `public/styles.css:30` — reused here, not a new style.)

- [ ] **Step 3: Update `public/index.html`'s logged-out button text**

Change:

```html
<a href="/login" class="btn-primary mt-2 w-full">Log in with Spotify</a>
```

to:

```html
<a href="/login" class="btn-primary mt-2 w-full">Log in</a>
```

- [ ] **Step 4: Update `public/sw.js`'s `BYPASS_PATHS`**

Change:

```javascript
const BYPASS_PATHS = new Set(['/login', '/callback', '/logout']);
```

to:

```javascript
const BYPASS_PATHS = new Set(['/login', '/login/spotify', '/login/google', '/callback', '/callback/google', '/logout']);
```

- [ ] **Step 5: Update `test/routes/auth.test.ts`'s `GET /login` tests to target `/login/spotify`, add `GET /login/google` tests**

In the `describe('GET /login', ...)` block, change every request URL from `/login` (and `/login?foo=bar`) to `/login/spotify` (and `/login/spotify?foo=bar`) — this applies to all 8 existing `it(...)` blocks in that describe (redirects-to-Spotify, omits/keeps Secure, canonical-host redirect, query-string preservation, allowlisted-host tests). Rename the describe block itself to `describe('GET /login/spotify', ...)`. The assertions themselves (redirect targets, cookie presence, `Location` values) are otherwise unchanged — only the request path changes.

Add a new describe block after it:

```typescript
describe('GET /login/google', () => {
  it('redirects to Google authorize with a state cookie set', async () => {
    const req = new Request('http://127.0.0.1:8787/login/google');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(res.headers.get('Set-Cookie')).toContain('wl_oauth_state=');
  });

  it('omits Secure on the state cookie over plain http, keeps it over https', async () => {
    const httpReq = new Request('http://127.0.0.1:8787/login/google');
    const httpRes = await worker.fetch(httpReq, env, {} as ExecutionContext);
    expect(httpRes.headers.get('Set-Cookie')).not.toContain('Secure');

    const httpsReq = new Request('https://wavelengthz.app/login/google');
    const httpsRes = await worker.fetch(httpsReq, env, {} as ExecutionContext);
    expect(httpsRes.headers.get('Set-Cookie')).toContain('Secure');
  });
});
```

Also add one test to the (renamed) `GET /login/spotify` describe block for the new intent cookie:

```typescript
  it('sets an additional wl_oauth_intent=connect cookie when reached with ?intent=connect', async () => {
    const req = new Request('http://127.0.0.1:8787/login/spotify?intent=connect');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.includes('wl_oauth_state='))).toBe(true);
    expect(setCookies.some((c) => c.includes('wl_oauth_intent=connect'))).toBe(true);
  });

  it('does not set wl_oauth_intent when reached without ?intent=connect', async () => {
    const req = new Request('http://127.0.0.1:8787/login/spotify');
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.includes('wl_oauth_intent'))).toBe(false);
  });
```

(`Headers.getSetCookie()` returns all `Set-Cookie` values as an array — confirmed present in this project's `@cloudflare/workers-types`; needed here since `res.headers.get('Set-Cookie')` only returns one combined/first value when multiple `Set-Cookie` headers exist.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/routes/auth.test.ts`
Expected: PASS (all cases green, including the renamed/moved `/login/spotify` tests and new `/login/google` tests)

- [ ] **Step 7: Commit**

```bash
git add src/routes/auth.ts public/login.html public/index.html public/sw.js test/routes/auth.test.ts
git commit -m "feat: add /login choice page, move Spotify login to /login/spotify, add /login/google"
```

---

### Task 4: `/callback` (Spotify) — email auto-link + connect-intent

**Files:**
- Modify: `src/routes/auth.ts`
- Modify: `test/routes/auth.test.ts`

**Interfaces:**
- Consumes: `getSessionUser` (already imported in Task 3).
- Produces: `/callback` now (a) links to an existing user found by email when no same-provider identity match exists, and (b) handles `?intent=connect` by linking the new Spotify identity to the currently logged-in user instead of running login/signup.

- [ ] **Step 1: Add the connect-intent branch and the email auto-link fallback to `/callback`**

In `src/routes/auth.ts`, insert this block immediately after the `tokenStatement` closure definition and before the existing `const existingIdentity = await env.DB.prepare(...)` line:

```typescript
    // ?intent=connect (set by /login/spotify) means "link this Spotify
    // account to my current session's user," not a fresh login/signup.
    const intentCookie = parseCookie(request, 'wl_oauth_intent');
    const clearIntentCookie = 'wl_oauth_intent=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

    if (intentCookie === 'connect') {
      const currentUser = await getSessionUser(request, env.DB);
      if (currentUser) {
        const claimedBy = await env.DB.prepare(
          `SELECT user_id FROM auth_identities WHERE provider = 'spotify' AND provider_id = ?`
        ).bind(profile.id).first<{ user_id: string }>();

        if (claimedBy && claimedBy.user_id !== currentUser.id) {
          const headers = new Headers({ Location: '/settings?spotify_error=already_linked' });
          headers.append('Set-Cookie', clearIntentCookie);
          return new Response(null, { status: 302, headers });
        }

        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
             VALUES (?, ?, 'spotify', ?, ?, ?, ?)
             ON CONFLICT(provider, provider_id) DO NOTHING`
          ).bind(crypto.randomUUID(), currentUser.id, profile.id, profile.email ?? null, now, now),
          tokenStatement(currentUser.id),
        ]);

        const headers = new Headers({ Location: '/settings?spotify_connected=1' });
        headers.append('Set-Cookie', clearIntentCookie);
        return new Response(null, { status: 302, headers });
      }
      // No active session (it expired mid-flow) -- fall through to normal
      // login/signup below, same as if intent had never been set.
    }

```

Then replace the existing `if (existingIdentity) { ... } else { ... }` block (the one that does `UPDATE users ... deleted_at = NULL` in the `if` branch and the 3-table `INSERT` in the `else` branch) with:

```typescript
    let userId: string;
    let onboarded: boolean;

    if (existingIdentity) {
      userId = existingIdentity.user_id;
      onboarded = existingIdentity.onboarded_at != null;

      await env.DB.batch([
        env.DB.prepare('UPDATE users SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(now, userId),
        tokenStatement(userId),
      ]);
    } else {
      // No Spotify identity yet -- check whether this email already belongs
      // to a user via a different provider (e.g. they signed up with Google
      // first) before creating a duplicate account. Not filtered by
      // deleted_at, same reactivation reasoning as the same-provider lookup
      // above.
      const existingByEmail = profile.email
        ? await env.DB.prepare(`SELECT id, onboarded_at, deleted_at FROM users WHERE email = ?`)
            .bind(profile.email)
            .first<{ id: string; onboarded_at: number | null; deleted_at: number | null }>()
        : null;

      if (existingByEmail) {
        userId = existingByEmail.id;
        onboarded = existingByEmail.onboarded_at != null;

        const statements = [
          env.DB.prepare(
            `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
             VALUES (?, ?, 'spotify', ?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), userId, profile.id, profile.email ?? null, now, now),
          tokenStatement(userId),
        ];
        if (existingByEmail.deleted_at != null) {
          statements.unshift(env.DB.prepare('UPDATE users SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(now, userId));
        }
        await env.DB.batch(statements);
      } else {
        userId = crypto.randomUUID();
        onboarded = false;

        // spotify_id is still a required, still-UNIQUE column on users (see
        // Task 1's migration note -- it's a platform constraint, not an
        // oversight, that it can't be dropped). Keep writing the real value
        // here for constraint satisfaction; auth_identities is what the
        // application actually reads going forward.
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO users (id, spotify_id, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
            .bind(userId, profile.id, profile.email ?? null, now, now),
          env.DB.prepare(
            `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
             VALUES (?, ?, 'spotify', ?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), userId, profile.id, profile.email ?? null, now, now),
          tokenStatement(userId),
        ]);
      }
    }
```

Finally, replace the handler's closing response construction:

```typescript
    const { cookie } = await createSession(env.DB, userId, requestIsSecure(request));

    return new Response(null, {
      status: 302,
      headers: {
        Location: onboarded ? '/' : '/onboarding',
        'Set-Cookie': cookie,
      },
    });
  });
```

with:

```typescript
    const { cookie } = await createSession(env.DB, userId, requestIsSecure(request));

    const headers = new Headers({ Location: onboarded ? '/' : '/onboarding' });
    headers.append('Set-Cookie', cookie);
    if (intentCookie) headers.append('Set-Cookie', clearIntentCookie);
    return new Response(null, { status: 302, headers });
  });
```

- [ ] **Step 2: Write the failing tests**

Append to the `describe('GET /callback', ...)` block in `test/routes/auth.test.ts`:

```typescript
  it('links to an existing user found by email instead of creating a duplicate, when no Spotify identity exists yet', async () => {
    const existingUserId = await insertTestUser(env.DB, { email: 'shared@example.com', skipSpotify: true, onboardedAt: Date.now() });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(JSON.stringify({ id: 'spotify-linkme', email: 'shared@example.com' }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/'); // already onboarded

    const identity = await env.DB.prepare(`SELECT user_id FROM auth_identities WHERE provider_id = 'spotify-linkme'`).first<any>();
    expect(identity.user_id).toBe(existingUserId); // linked, not a new user

    const usersCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE email = 'shared@example.com'`).first<any>();
    expect(usersCount.c).toBe(1); // no duplicate

    vi.unstubAllGlobals();
  });

  it('connects Spotify to the currently logged-in user when intent=connect, without creating a new account', async () => {
    const googleUserId = await insertTestUser(env.DB, { email: 'connectme@example.com', skipSpotify: true, onboardedAt: Date.now() });
    const { id: sessionId } = await createSession(env.DB, googleUserId);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(JSON.stringify({ id: 'spotify-connect-target', email: 'different@example.com' }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: `wl_oauth_state=match; wl_oauth_intent=connect; wl_session=${sessionId}` },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/settings?spotify_connected=1');

    const identity = await env.DB.prepare(`SELECT user_id FROM auth_identities WHERE provider_id = 'spotify-connect-target'`).first<any>();
    expect(identity.user_id).toBe(googleUserId);

    const tokenRow = await env.DB.prepare(`SELECT * FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`).bind(googleUserId).first<any>();
    expect(tokenRow).toBeTruthy();

    const usersCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM users`).first<any>();
    expect(usersCount.c).toBe(1); // no second user created

    vi.unstubAllGlobals();
  });

  it('rejects connecting a Spotify account that is already linked to a different user', async () => {
    const userA = await insertTestUser(env.DB, { spotifyId: 'spotify-already-claimed' });
    const userB = await insertTestUser(env.DB, { email: 'userb@example.com', skipSpotify: true, onboardedAt: Date.now() });
    const { id: sessionId } = await createSession(env.DB, userB);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('accounts.spotify.com/api/token')) {
          return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('api.spotify.com/v1/me')) {
          return new Response(JSON.stringify({ id: 'spotify-already-claimed', email: 'usera@example.com' }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback?code=abc&state=match', {
      headers: { Cookie: `wl_oauth_state=match; wl_oauth_intent=connect; wl_session=${sessionId}` },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/settings?spotify_error=already_linked');

    const identity = await env.DB.prepare(`SELECT user_id FROM auth_identities WHERE provider_id = 'spotify-already-claimed'`).first<any>();
    expect(identity.user_id).toBe(userA); // unchanged, still belongs to user A

    vi.unstubAllGlobals();
  });
```

Add the `insertTestUser`/`createSession` imports if not already present at the top of the file (both are already imported per Task 3's state — no change needed there).

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/routes/auth.test.ts`
Expected: FAIL — the three new tests fail (no email fallback, no connect-intent handling yet).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/routes/auth.test.ts`
Expected: PASS (all cases green, including the three new ones and all pre-existing `/callback` tests unaffected)

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.ts test/routes/auth.test.ts
git commit -m "feat: add email-based auto-link and Connect-Spotify intent handling to /callback"
```

---

### Task 5: `/callback/google`

**Files:**
- Modify: `src/routes/auth.ts`
- Modify: `test/routes/auth.test.ts`

**Interfaces:**
- Consumes: `exchangeGoogleCode`, `fetchGoogleProfile` (Task 1).
- Produces: `GET /callback/google` — mirrors `/callback`'s normal login/signup path (identity lookup, email auto-link, reactivation, new-user creation), with no token storage and no connect-intent handling (out of scope per the design).

- [ ] **Step 1: Add the `/callback/google` route**

Add the import: `import { exchangeGoogleCode, fetchGoogleProfile } from '../lib/google';` (alongside the existing `buildGoogleAuthUrl` import from Task 3 — combine into one import line from `'../lib/google'`).

Add this route to `src/routes/auth.ts`, after `/login/google` and before `/callback`:

```typescript
  router.get('/callback/google', async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieState = parseCookie(request, 'wl_oauth_state');

    if (!code || !state || !cookieState || state !== cookieState) {
      return new Response('Invalid OAuth state', { status: 400 });
    }

    const token = await exchangeGoogleCode(code, env);
    const profile = await fetchGoogleProfile(token.access_token);
    const now = Date.now();

    // Same deliberately-unfiltered-by-deleted_at reactivation reasoning as
    // the Spotify callback's identity lookup.
    const existingIdentity = await env.DB.prepare(
      `SELECT ai.user_id, u.onboarded_at FROM auth_identities ai
       JOIN users u ON u.id = ai.user_id
       WHERE ai.provider = 'google' AND ai.provider_id = ?`
    )
      .bind(profile.sub)
      .first<{ user_id: string; onboarded_at: number | null }>();

    let userId: string;
    let onboarded: boolean;

    if (existingIdentity) {
      userId = existingIdentity.user_id;
      onboarded = existingIdentity.onboarded_at != null;
      await env.DB.prepare('UPDATE users SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(now, userId).run();
    } else {
      // Only trust the email if Google itself vouches for it -- unlike
      // Spotify (no verification flag exposed at all), Google's userinfo
      // response says explicitly whether the email is verified.
      const existingByEmail = profile.email_verified && profile.email
        ? await env.DB.prepare(`SELECT id, onboarded_at, deleted_at FROM users WHERE email = ?`)
            .bind(profile.email)
            .first<{ id: string; onboarded_at: number | null; deleted_at: number | null }>()
        : null;

      if (existingByEmail) {
        userId = existingByEmail.id;
        onboarded = existingByEmail.onboarded_at != null;

        const statements = [
          env.DB.prepare(
            `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
             VALUES (?, ?, 'google', ?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), userId, profile.sub, profile.email ?? null, now, now),
        ];
        if (existingByEmail.deleted_at != null) {
          statements.unshift(env.DB.prepare('UPDATE users SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(now, userId));
        }
        await env.DB.batch(statements);
      } else {
        userId = crypto.randomUUID();
        onboarded = false;

        // A Google-only user has no real Spotify id -- spotify_id is still
        // UNIQUE NOT NULL (Task 1's migration note), so this user's own id
        // (guaranteed unique, already generated) is written as a harmless
        // placeholder. auth_identities is what the application actually
        // reads; this column is never read for a Google-signed-in user.
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO users (id, spotify_id, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
            .bind(userId, userId, profile.email ?? null, now, now),
          env.DB.prepare(
            `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
             VALUES (?, ?, 'google', ?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), userId, profile.sub, profile.email ?? null, now, now),
        ]);
      }
    }

    const { cookie } = await createSession(env.DB, userId, requestIsSecure(request));

    return new Response(null, {
      status: 302,
      headers: {
        Location: onboarded ? '/' : '/onboarding',
        'Set-Cookie': cookie,
      },
    });
  });

```

- [ ] **Step 2: Write the failing tests**

Add a new describe block to `test/routes/auth.test.ts`, after the `GET /callback` describe block:

```typescript
describe('GET /callback/google', () => {
  it('rejects a callback whose state does not match the cookie', async () => {
    const req = new Request('http://localhost/callback/google?code=abc&state=wrong', {
      headers: { Cookie: 'wl_oauth_state=right' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it('creates a new user with a placeholder spotify_id and a google auth_identities row, no music_source_tokens row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'gtoken', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
          return new Response(JSON.stringify({ sub: 'google-xyz', email: 'guser@example.com', email_verified: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback/google?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/onboarding');
    expect(res.headers.get('Set-Cookie')).toContain('wl_session=');

    const identity = await env.DB.prepare(`SELECT * FROM auth_identities WHERE provider = 'google' AND provider_id = 'google-xyz'`).first<any>();
    expect(identity).toBeTruthy();
    expect(identity.email).toBe('guser@example.com');

    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(identity.user_id).first<any>();
    expect(user.spotify_id).toBe(identity.user_id); // placeholder = own id
    expect(user.email).toBe('guser@example.com');

    const tokenRow = await env.DB.prepare(`SELECT * FROM music_source_tokens WHERE user_id = ?`).bind(identity.user_id).first();
    expect(tokenRow).toBeNull();

    vi.unstubAllGlobals();
  });

  it('links to an existing Spotify-created user by email when Google reports it verified', async () => {
    const existingUserId = await insertTestUser(env.DB, { email: 'shared2@example.com', onboardedAt: Date.now() });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'gtoken', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
          return new Response(JSON.stringify({ sub: 'google-linkme', email: 'shared2@example.com', email_verified: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback/google?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/'); // already onboarded

    const identity = await env.DB.prepare(`SELECT user_id FROM auth_identities WHERE provider_id = 'google-linkme'`).first<any>();
    expect(identity.user_id).toBe(existingUserId);

    vi.unstubAllGlobals();
  });

  it('does not auto-link by email when Google reports it unverified', async () => {
    await insertTestUser(env.DB, { email: 'unverified@example.com', onboardedAt: Date.now() });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'gtoken', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
          return new Response(JSON.stringify({ sub: 'google-unverified', email: 'unverified@example.com', email_verified: false }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback/google?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/onboarding'); // treated as a brand-new user

    const usersCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE email = 'unverified@example.com'`).first<any>();
    expect(usersCount.c).toBe(2); // did NOT link -- a second, separate user was created

    vi.unstubAllGlobals();
  });

  it('reactivates a soft-deleted account found by identity', async () => {
    const now = Date.now();
    const userId = await insertTestUser(env.DB, { skipSpotify: true, onboardedAt: now, deletedAt: now, email: 'gsoftdel@example.com' });
    await env.DB.prepare(
      `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at) VALUES (?, ?, 'google', 'google-soft-deleted', ?, ?, ?)`
    ).bind(crypto.randomUUID(), userId, 'gsoftdel@example.com', now, now).run();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'gtoken', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
          return new Response(JSON.stringify({ sub: 'google-soft-deleted', email: 'gsoftdel@example.com', email_verified: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const req = new Request('http://localhost/callback/google?code=abc&state=match', {
      headers: { Cookie: 'wl_oauth_state=match' },
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');

    const user = await env.DB.prepare('SELECT deleted_at FROM users WHERE id = ?').bind(userId).first<any>();
    expect(user.deleted_at).toBeNull();

    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/routes/auth.test.ts`
Expected: FAIL — `/callback/google` doesn't exist yet (404s).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/routes/auth.test.ts`
Expected: PASS (all cases green)

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.ts test/routes/auth.test.ts
git commit -m "feat: add /callback/google login/signup flow"
```

---

### Task 6: `/api/me` guard + "Connect Spotify" Settings UI

**Files:**
- Modify: `src/routes/me.ts`
- Modify: `test/routes/me.test.ts`
- Modify: `public/settings.html`
- Modify: `public/settings.js`

**Interfaces:**
- Produces: `GET /api/me`'s response gains a top-level `hasSpotify: boolean` field. When false, `musicProfile` is `null` and the Spotify top-artists/tracks fetch is skipped entirely (no longer throws for a Google-only user).

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/me.test.ts`:

```typescript
  it('returns hasSpotify: false and musicProfile: null for a user with no linked Spotify account, without calling getValidAccessToken', async () => {
    await insertTestUser(env.DB, { id: 'u5', skipSpotify: true });
    const { cookie } = await createSession(env.DB, 'u5');
    const sessionId = cookie.split(';')[0].split('=')[1];

    const fetchMock = vi.fn(async () => {
      throw new Error('should not call Spotify for a user with no linked account');
    });
    vi.stubGlobal('fetch', fetchMock);

    const req = new Request('http://localhost/api/me', { headers: { Cookie: `wl_session=${sessionId}` } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.hasSpotify).toBe(false);
    expect(body.musicProfile).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('returns hasSpotify: true for a user with a linked Spotify account', async () => {
    const encToken = await encrypt('access-tok', env.TOKEN_ENCRYPTION_KEY);
    await insertTestUser(env.DB, {
      id: 'u6', spotifyId: 'sp6', accessToken: encToken, refreshToken: encToken,
      tokenExpiresAt: Date.now() + 100000, createdAt: 1000, updatedAt: 1000,
    });
    const { cookie } = await createSession(env.DB, 'u6');
    const sessionId = cookie.split(';')[0].split('=')[1];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = input.toString();
        if (url.includes('top/artists')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
        if (url.includes('top/tracks')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const req = new Request('http://localhost/api/me', { headers: { Cookie: `wl_session=${sessionId}` } });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const body = await res.json<any>();
    expect(body.hasSpotify).toBe(true);

    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/me.test.ts`
Expected: FAIL — the first new test throws (calls `getValidAccessToken` and Spotify unconditionally); `hasSpotify` is `undefined` in both.

- [ ] **Step 3: Update `src/routes/me.ts`**

Replace the handler body from `let profile = await env.DB.prepare(...)` through the `const tokenRow = ...` / `const safeUser = ...` lines at the end with:

```typescript
    const hasSpotifyRow = await env.DB.prepare(
      `SELECT 1 FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`
    ).bind(user.id).first();
    const hasSpotify = !!hasSpotifyRow;

    let profile: any = null;

    if (hasSpotify) {
      profile = await env.DB.prepare('SELECT * FROM music_profiles WHERE user_id = ?')
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
        const topArtists = JSON.stringify(artists.map((a) => ({ artist_id: a.id, rank: a.rank, name: a.name, imageUrl: a.imageUrl })));
        const topTracks = JSON.stringify(tracks.map((t) => ({ track_id: t.id, rank: t.rank, name: t.name, imageUrl: t.imageUrl })));
        const topGenres = JSON.stringify([...genreRank.keys()]);
        const now = Date.now();

        await env.DB.prepare(
          `INSERT OR IGNORE INTO music_profiles (user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(user.id, topArtists, topTracks, topGenres, TIME_RANGE, now).run();

        profile = { user_id: user.id, top_artists: topArtists, top_tracks: topTracks, top_genres: topGenres, time_range: TIME_RANGE, refreshed_at: now };
      }
    }

    const tokenRow = hasSpotify
      ? await env.DB.prepare(`SELECT avatar_url FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`)
          .bind(user.id)
          .first<{ avatar_url: string | null }>()
      : null;

    const safeUser = { ...user, spotify_avatar_url: tokenRow?.avatar_url ?? null };
    return Response.json({ user: safeUser, musicProfile: profile, hasSpotify });
```

(Every existing code path — the concurrent-insert-race handling, the no-genres-field handling, the clean-500-on-throw behavior — is unchanged; it's now just nested one level deeper inside `if (hasSpotify)`, and only reachable when `hasSpotify` is true, exactly as before for every existing Spotify-linked user.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/routes/me.test.ts`
Expected: PASS (all cases green, including the 2 new tests)

- [ ] **Step 5: Add the "Connect Spotify" UI to Settings**

In `public/settings.html`, replace:

```html
  <div x-show="spotifyAvatarUrl" class="mx-auto mb-4 flex max-w-md items-center gap-3">
    <img :src="spotifyAvatarUrl" alt="" class="h-12 w-12 rounded-full object-cover" />
    <div class="text-sm">
      <p class="font-semibold text-neutral-200">Connected via Spotify</p>
      <p class="text-neutral-500">This photo is never shown to matches -- it's just your account identity.</p>
    </div>
  </div>
```

with:

```html
  <div x-show="hasSpotify" class="mx-auto mb-4 flex max-w-md items-center gap-3">
    <img :src="spotifyAvatarUrl" alt="" class="h-12 w-12 rounded-full object-cover" />
    <div class="text-sm">
      <p class="font-semibold text-neutral-200">Connected via Spotify</p>
      <p class="text-neutral-500">This photo is never shown to matches -- it's just your account identity.</p>
    </div>
  </div>
  <div x-show="!hasSpotify" class="mx-auto mb-4 max-w-md">
    <a href="/login/spotify?intent=connect" class="btn-primary block w-full text-center">Connect Spotify</a>
    <p class="mt-1 text-center text-xs text-neutral-500">Link your Spotify account for music-taste matching.</p>
  </div>
  <p x-show="info" x-text="info" class="mx-auto mb-4 max-w-md text-brand-400" role="status"></p>
```

- [ ] **Step 6: Wire `hasSpotify` and the connect-result query params into `public/settings.js`**

In the Alpine component's data (near where `spotifyAvatarUrl` is initialized, e.g. `spotifyAvatarUrl: null,`), add:

```javascript
      hasSpotify: false,
      info: null,
```

In `init()`, after the existing `this.spotifyAvatarUrl = me.user.spotify_avatar_url ?? null;` line, add:

```javascript
        this.hasSpotify = me.hasSpotify ?? false;

        const params = new URLSearchParams(window.location.search);
        if (params.get('spotify_connected') === '1') {
          this.info = 'Spotify connected.';
        } else if (params.get('spotify_error') === 'already_linked') {
          this.error = 'That Spotify account is already linked to a different Wavelengthz account.';
        }
        if (params.has('spotify_connected') || params.has('spotify_error')) {
          window.history.replaceState({}, '', '/settings');
        }
```

- [ ] **Step 7: Run the full suite and type-check**

Run: `npx vitest run`
Expected: all files pass, including every earlier task's tests unaffected.

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add src/routes/me.ts test/routes/me.test.ts public/settings.html public/settings.js
git commit -m "feat: add /api/me hasSpotify guard and Connect Spotify settings action"
```
