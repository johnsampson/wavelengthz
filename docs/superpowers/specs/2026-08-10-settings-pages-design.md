# Split Settings into Multiple Pages — Design

**Status:** Approved, pending implementation plan.

## Goal

Replace the single `/settings` page (one long form covering profile fields, matching preferences, notifications, Spotify connection, and account deletion) with a hub-and-list navigation: `/settings` becomes a simple menu, and each concern gets its own page.

## Current State (verified directly against the code)

- `public/settings.html` + `public/settings.js` is one Alpine app covering: Spotify connect/status, the iOS install banner, the push-notification toggle (all shipped in the recent Web Push feature), a single form (display name, gender, seeking, intent, location + "update my location," max distance, age range, Save), a photos grid/upload section, a "Preview my profile" link, a "Log out" button, and a "Delete my account" confirm-flow.
- Every top-level page in this app is a static HTML file served via the `ASSETS` binding fallback (`router.all('*', ...)` in `src/index.ts`) — `public/matches.html` resolves at `/matches`, `public/settings.html` at `/settings`, etc. No server-side routing/templating; each page has its own `<script type="module">` importing a matching `createXApp()` factory from its own `.js` file (e.g. `settings.html` imports `createSettingsApp` from `settings.js`).
- `public/nav.js` renders two shared, client-side-injected pieces into placeholder elements every page includes: `mountHeader()` (wordmark + notification bell, into `#wl-header-root`) and `mountNav()` (the fixed bottom tab bar — Deck/History/Matches/Groups/Settings, into `#wl-nav-root`). `getActiveTab(pathname)` does an **exact** match against `NAV_ITEMS`' five `href`s to decide which tab highlights.
- This app has no existing "sub-page with back-navigation" pattern anywhere — `match.html`, `group.html`, `artist.html`, `profile.html` are all flat, single-purpose pages reached via in-app links or the bottom tab bar, with no back arrow/breadcrumb convention to follow.
- Settings' single form saves via `POST /api/onboarding`, which unconditionally rewrites the entire profile-setup field set (confirmed in `settings.js`'s existing comment: *"That endpoint does an unconditional `SET bio = ?`, so every field it owns has to be echoed back or it gets clobbered"*). The existing form already echoes back fields it doesn't display (`bio`, `date_of_birth`) for exactly this reason.
- `/api/me` (`src/routes/me.ts`) returns `hasSpotify` today; there is no equivalent field for Google sign-in status. Out of scope here — Account connections stays Spotify-only.

## Navigation Structure

`/settings` (rewritten, much smaller) becomes a list-menu hub:

1. **Profile** → `/settings/profile`
2. **Preferences** → `/settings/preferences`
3. **Notifications** → `/settings/notifications`
4. **Account connections** → `/settings/connections`
5. **Preview my profile** — action row, links straight to `/profile?id=<userId>` (no sub-page, same as today)
6. **Log out** — action row, fires the existing `logout()` flow immediately (no sub-page)

Each of the four section pages gets a small "← Settings" link at the top, back to `/settings` — the one new UI convention this introduces, since nothing else in the app has back-navigation today. `nav.js`'s `getActiveTab` is updated so any `/settings/*` path still highlights the bottom nav's Settings tab (currently an exact-match check against `/settings` only).

## Section Boundaries

- **Profile** (`settings-profile.html`/`.js`): Display name, Photos (grid + upload), **Delete my account** (moved here from the bottom of the old single page — grouped with identity/account-lifecycle rather than matching preferences or connections).
- **Preferences** (`settings-preferences.html`/`.js`): Gender, Seeking, I'm interested in (intent), Location + "Update my current location" (with its existing 7-day cooldown), Max distance, Age range. Location moves here rather than Profile because it's paired with Max distance in the same match-radius calculation today — keeping "who can see/find me" as one mental model.
- **Notifications** (`settings-notifications.html`/`.js`): The push-notification toggle and iOS install banner, moved as-is from the current page — no behavior change, just relocated.
- **Account connections** (`settings-connections.html`/`.js`): Spotify connect/status block, moved as-is. Google sign-in gets no UI surface here (would need a new `/api/me` field — explicitly out of scope for this pass).

## Data Flow

No backend changes. Each of Profile and Preferences is a self-contained Alpine app that, on `init()`, calls `api.me()` (and `api.myPhotos()` for Profile) the same way the current single page does. On save, each independently calls `api.onboard({...})`, echoing back every field `POST /api/onboarding` owns — including the other page's fields — exactly matching how the current form already echoes back `bio`/`date_of_birth` that it doesn't display. This is a direct consequence of `/api/onboarding`'s existing unconditional-rewrite behavior, not a new constraint introduced by this split.

Notifications and Account connections pages don't touch `/api/onboarding` at all — they call the same push/Spotify-specific endpoints (`/api/push/*`, `/login/spotify`) the current page already does, just from their own file.

## Files

The Workers Static Assets clean-URL resolution that already serves `public/matches.html` at `/matches` resolves a nested file the same way (`public/settings/profile.html` at `/settings/profile`) — so the four section pages need to physically live in a `public/settings/` directory, not as flat hyphenated filenames at the top level (`public/settings-profile.html` would resolve at `/settings-profile`, not `/settings/profile`). `public/settings.html` (the hub file) and the `public/settings/` directory coexist without conflict — different paths on the filesystem, and Cloudflare resolves `/settings` to the former, `/settings/profile` etc. to the latter.

- Rewrite: `public/settings.html`, `public/settings.js` (hub — list menu only)
- Create: `public/settings/profile.html`, `public/settings/profile.js`
- Create: `public/settings/preferences.html`, `public/settings/preferences.js`
- Create: `public/settings/notifications.html`, `public/settings/notifications.js`
- Create: `public/settings/connections.html`, `public/settings/connections.js`
- Modify: `public/nav.js` (`getActiveTab` prefix-matches `/settings`)
- No changes to `public/app.js`'s `api` object — every method it needs already exists.
- Test files split to mirror: existing `test/public/settings.test.ts` coverage divided into `test/public/settings.test.ts` (hub), `test/public/settings/profile.test.ts`, `test/public/settings/preferences.test.ts`, `test/public/settings/notifications.test.ts`, `test/public/settings/connections.test.ts`.

## Testing

Same Vitest + stubbed-`fetch`/`window`/`navigator` pattern the current `test/public/settings.test.ts` already uses — no new testing approach, just the existing coverage redistributed across the new files (each new page's `init()`/save/toggle behavior tested the same way its equivalent code is tested today).

## Verify Empirically

This app has no existing nested static route — every page today is a single-segment pretty URL (`/matches`, `/settings`), never a multi-segment one like `/settings/profile`. The Workers Static Assets binding's clean-URL handling is documented to resolve nested files the same way it resolves top-level ones, but since this repo has never actually exercised a multi-segment path, the plan's first task should confirm `public/settings/profile.html` really does resolve at `/settings/profile` in `wrangler dev` before building out all four pages against that assumption.
