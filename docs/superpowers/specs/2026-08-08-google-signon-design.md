# Google Sign-On (Phase 2) — Design

**Status:** Approved, pending implementation plan.

## Goal

Add Google as a second login option alongside Spotify, on top of the `auth_identities`/`music_source_tokens` tables already built in Phase 1 (`docs/superpowers/specs/2026-08-08-auth-provider-tables-design.md`). Both providers are shown as equal choices; a user can end up with either or both linked to one account. No schema migration is needed — Phase 1's tables already support an arbitrary `provider` value.

## Constraints Carried From Earlier Discussion

- Both "Continue with Spotify" and "Continue with Google" are shown; neither is primary.
- No forced Spotify-linking gate. A Google-only user can use the whole app immediately except their personal Spotify-taste overlap score and "Top on Spotify" display — confirmed in Phase 1 discussion that everything else already works off the shared catalog + client-credentials token.
- Auto-link by verified email: a sign-in whose provider vouches for the email (Google's `email_verified: true`) links into an existing account with that email instead of creating a duplicate. Spotify's API has no explicit verification flag; since Spotify itself requires a verified email at account creation on their end, this design treats Spotify-supplied email as trustworthy too, for symmetry — called out explicitly here since it's an assumption, not a confirmed API guarantee.
- This PR also includes a "Connect Spotify" action in Settings for a Google-only user, per explicit scope decision. A symmetric "Connect Google" for a Spotify-first user is not built now (falls out of the same mechanism cheaply later, but wasn't asked for).
- Not replicating the just-merged `SPOTIFY_ALLOWED_HOSTS` Cloudflare Tunnel-testing mechanism for Google in this PR — noted as a cheap follow-up, not built now.

## Current State (verified directly against the code)

- `/login` (`src/routes/auth.ts`) is a live route handler today, not a static page: it canonicalizes onto an allowed host, sets the `wl_oauth_state` cookie, and 302s straight to Spotify. This whole flow moves to `/login/spotify`.
- `/callback` looks up `auth_identities` by `(provider='spotify', provider_id)`; on no match, creates a new `users` row (`spotify_id` = the real Spotify id), a matching `auth_identities` row, and a `music_source_tokens` row, all in one `env.DB.batch()`.
- `/api/me` (`src/routes/me.ts`) unconditionally calls `getValidAccessToken` when there's no cached `music_profiles` row — this throws today for any user with zero `music_source_tokens` rows (not reachable yet; becomes reachable the moment a Google-only user exists).
- `public/sw.js`'s `BYPASS_PATHS` (currently `/login`, `/callback`, `/logout`) exists specifically because a service worker intercepting an OAuth redirect breaks the state-cookie round-trip — any new OAuth-adjacent path needs the same treatment.
- Static pages under `public/` are served automatically via the `ASSETS` binding fallback (`src/index.ts`'s `router.all('*', ...)`) for any path with no explicit route handler — so a new page needs no custom route, just a file.

## New Library: `src/lib/google.ts`

Mirrors `src/lib/spotify.ts`'s shape:
- `buildGoogleAuthUrl(state: string, env: Env, redirectUri: string): string`
- `exchangeGoogleCode(code: string, env: Env, redirectUri: string): Promise<{ access_token: string; expires_in: number }>`
- `fetchGoogleProfile(accessToken: string): Promise<{ sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }>` — hits Google's standard OIDC userinfo endpoint (`https://openidconnect.googleapis.com/v1/userinfo`).

No Google access/refresh tokens are ever persisted — identity only, matching the Phase 1 design's premise that `music_source_tokens` is exclusively for providers needing ongoing API access.

## Routing Changes

- `router.get('/login', ...)` is **removed** from `auth.ts`. `public/login.html` (new, static) replaces it via the `ASSETS` fallback — two buttons/links, "Continue with Spotify" → `/login/spotify`, "Continue with Google" → `/login/google`.
- `router.get('/login/spotify', ...)` — today's `/login` handler moved verbatim (host-canonicalization, `isAllowedHost`, state cookie, redirect to Spotify). Additionally: if reached with `?intent=connect`, sets a second short-lived cookie, `wl_oauth_intent=connect` (`Max-Age=600`, same as the state cookie), used by `/callback` below.
- `router.get('/login/google', ...)` — new, simpler equivalent: no allowed-host dance (out of scope per the constraint above), redirect_uri is always `env.GOOGLE_REDIRECT_URI`. Sets the same `wl_oauth_state` cookie.
- `router.get('/callback', ...)` (Spotify, existing) gains two behaviors:
  1. **Connect-intent branch**, checked first: if `wl_oauth_intent=connect` cookie is present AND `getSessionUser` resolves an active session, this is "link Spotify to my current account," not login/signup. Look up whether this Spotify `provider_id` is already in `auth_identities`: if linked to a *different* user, redirect to `/settings?spotify_error=already_linked`; otherwise insert `auth_identities` + `music_source_tokens` for the **current session's user_id** (not a new user), clear both OAuth cookies, redirect to `/settings?spotify_connected=1`. `users.spotify_id`'s placeholder value is left untouched — nothing reads it, so there's no reason to touch a `UNIQUE` column for zero benefit.
  2. **Auto-link fallback** in the normal login/signup path: when no `auth_identities` match is found, check for an existing user by email (`SELECT id FROM users WHERE email = ?`, deliberately not filtered by `deleted_at` — same reactivation reasoning as the same-provider lookup) before creating a new one. If found: clear `deleted_at` if set (reactivation, matching the same-provider path), then link (insert `auth_identities` + `music_source_tokens` onto that user) instead of duplicating.
- `router.get('/callback/google', ...)` (new) — same shape as Spotify's normal login/signup path, minus token storage: look up `auth_identities` by `(google, sub)`; if not found, check the same email fallback (only when `profile.email_verified === true`), including the same reactivation-on-match behavior; if still not found, create a new `users` row (`spotify_id` = the new user's own `id`, per Phase 1's spec guidance for a non-Spotify user) + one `auth_identities` row (no `music_source_tokens` row). Session + redirect logic identical to Spotify's.

## `/api/me` Guard

Add a `hasSpotify` boolean to the response, computed via `SELECT 1 FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`. When false, skip the top-artists/tracks fetch entirely and return `musicProfile: null` instead of throwing.

## Frontend Changes

- `public/login.html` (new) — reuses the existing logged-out card styling from `index.html`, two buttons.
- `public/index.html`'s logged-out card: button text changes from "Log in with Spotify" to "Log in" (still links to `/login`, which now shows the choice).
- `public/settings.js`/`settings.html`: the existing Spotify-avatar block (shown via `spotifyAvatarUrl`) is now conditioned on the new `hasSpotify` field; when false, show a "Connect Spotify" button linking to `/login/spotify?intent=connect` instead.
- `public/sw.js`'s `BYPASS_PATHS` gains `/login/spotify`, `/login/google`, `/callback/google` (and keeps `/login`, now harmless but left in for safety since it's no longer part of an OAuth redirect chain).

## Config

- New secrets (matching `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`'s treatment in `src/env.d.ts`, set via `wrangler secret put`, never committed): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- New plain var (matching `SPOTIFY_REDIRECT_URI`'s treatment in `wrangler.toml`'s `[vars]`): `GOOGLE_REDIRECT_URI` (local dev: `http://127.0.0.1:8787/callback/google`).
- No new migration — Phase 1's tables already support this without schema changes.

## Error Handling

- An OAuth failure (Google or Spotify token exchange/profile fetch) surfaces the same way the existing Spotify path already does — no new error-handling pattern invented.
- The "already linked to a different user" case in the connect-intent branch redirects with a query param the Settings page reads to show a clear message, rather than a raw error page — connecting an account you don't control is a normal user mistake (e.g. trying to link a Spotify account already used by an ex/roommate), not a system error.

## Testing

- `src/lib/google.ts` — unit tests mirroring `test/lib/spotify.test.ts`'s pattern (mocked `fetch`, real request-shape assertions).
- `/login/spotify`, `/login/google` — cookie-setting and redirect-target assertions, mirroring existing `/login` tests.
- `/callback/google` — new-user creation, existing-user login, and the email-based auto-link case (a Google sign-in matching an existing Spotify-created user's email).
- `/callback` (Spotify) — the email-auto-link case in the other direction (symmetry), and the full connect-intent flow (success, and the already-linked-to-someone-else rejection).
- `/api/me` — the `hasSpotify: false` / `musicProfile: null` path for a Google-only user, using `insertTestUser`-created fixtures with no `music_source_tokens` row.
- `public/sw.js`'s bypass set isn't unit-testable in this codebase's existing test suite (no JS tests target `sw.js`) — verified by inspection only, consistent with how the original three paths were handled.

## Out of Scope

- Replicating `SPOTIFY_ALLOWED_HOSTS`-style Cloudflare Tunnel support for Google.
- A symmetric "Connect Google" action for a Spotify-first user.
- Persisting or using any Google API scope beyond identity (no Google Calendar/Contacts/etc.).
