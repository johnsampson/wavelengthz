# Web Push Notifications (Plan 1) — Design

**Status:** Approved, pending implementation plan.

## Goal

Add push notifications for new matches and new 1:1 messages, on iOS and Android, without a native app, App Store, Play Store, Apple Developer Program, or DUNS number. Delivered via the standard Web Push API against the PWA that already exists (`public/manifest.json`, `public/sw.js`) — this closes out the existing backlog line in GitHub issue #2 ("Can this application tool up Push notifications on iphone and android?").

The native-app + store-distribution path (where Apple Developer enrollment, and DUNS if ever registering as an Organization, actually comes into play) is deliberately out of scope here — captured separately as a lightweight roadmap, not an implementation plan (see "Plan 2" below).

## Why Web Push, Not a Native App

Web Push (Push API + Service Worker + VAPID) needs no app-store presence at all — Android Chrome supports it in a regular browser tab today; iOS Safari has supported it since 16.4, but **only** for a PWA added to the home screen (Safari blocks the permission prompt entirely otherwise). Neither platform requires Apple/Google developer program enrollment for this path. A native wrapper (Capacitor + APNs/FCM) would add real recurring cost, app-review risk, and DUNS complexity (only if registering as an Organization) for no benefit over Web Push at this stage — queued as Plan 2 instead.

## Current State (verified directly against the code)

- `public/manifest.json` already sets `"display": "standalone"` — required for iOS to treat the installed PWA as push-eligible. No manifest change needed.
- `public/sw.js` (`CACHE_NAME = 'wavelengthz-shell-v19'`) has no `push` or `notificationclick` listener today.
- `src/lib/notifications.ts` already fires on two events via `notifyMatch`/`notifyMessage`: a new match (after `getMatchNotificationDelayMs`'s cancellation window, swept by the `0 4 * * sun`-adjacent cron in `src/index.ts`) and a new 1:1 message (called directly from `src/routes/matches.ts` right after the message insert). Each currently only calls `sendEmail`. Group chat (`src/routes/groups.ts`) has no notification hook of any kind yet — out of scope here, matching the existing email behavior.
- `package.json` has exactly one runtime dependency (`itty-router`) and `compatibility_flags = ["nodejs_compat"]` is already set in `wrangler.toml`. No push-related code or dependency exists anywhere in the repo today.
- `src/env.d.ts` is the established pattern for ambient secret types (`SPOTIFY_CLIENT_ID`, `GOOGLE_CLIENT_ID`, etc.) — secrets are never declared in `wrangler.toml`, only set via `wrangler secret put`.
- `public/settings.html`/`settings.js` is the established pattern for a Settings-page toggle backed by `/api/me` state (see `hasSpotify`).

## New Library: `src/lib/webPush.ts`

Implements the Web Push send directly against Workers' native `crypto.subtle` — no new npm dependency, matching this repo's near-zero-dependency posture:
- **RFC 8291** (message encryption): ECDH over P-256 between an ephemeral server keypair and the subscription's `p256dh` key, HKDF-derived content-encryption key and nonce, AES-128-GCM payload encryption using the subscription's `auth` secret as salt input.
- **RFC 8292** (VAPID): an ES256-signed JWT (`aud` = the push endpoint's origin, `exp` ≤ 24h out, `sub` = a contact URL/mailto) sent as an `Authorization: vapid t=…, k=…` header alongside the encrypted body.
- `sendWebPush(subscription: {endpoint, p256dh, auth}, payload: {title, body, url}, env: Env): Promise<{ok: true} | {ok: false, expired: boolean}>` — `expired: true` on a 404/410 response (the push service says the subscription is gone), which the caller uses to delete that row.

This is genuinely intricate cryptography. It gets its own file, isolated from the rest of the app, with unit tests run against known RFC 8291/8292 test vectors rather than only round-trip self-tests. If hand-rolling against `crypto.subtle` proves unworkable in the Workers runtime (verify empirically as the first implementation step), fall back to evaluating whether the `web-push` npm package functions under `nodejs_compat` before adding it as a dependency — not the default assumption, since it depends on Node's `crypto` module in ways `nodejs_compat` may only partially cover.

## Data Model

New migration `0009_add_push_subscriptions.sql`:

```sql
CREATE TABLE push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  endpoint    TEXT NOT NULL UNIQUE,  -- one row per browser/device subscription
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
```

One user can hold several rows (phone + laptop, or a re-subscribe after clearing browser data producing a new `endpoint`). `endpoint UNIQUE` is the natural dedupe key — subscribing again with the same endpoint is an upsert, not a new row.

## Routes

- `GET /api/push/vapid-public-key` — unauthenticated (the public key isn't secret; the frontend needs it before a session necessarily exists in a fresh tab). Returns `{ publicKey: env.VAPID_PUBLIC_KEY }`.
- `POST /api/push/subscribe` — auth-gated (`getSessionUser`, same as every other `/api/*` route). Body is the browser's `PushSubscription.toJSON()` shape (`{endpoint, keys: {p256dh, auth}}`); upserts into `push_subscriptions` by `endpoint`.
- `POST /api/push/unsubscribe` — auth-gated. Body `{endpoint}`; deletes the matching row for the current user.

## Trigger Points

`notifyMatch` and `notifyMessage` (`src/lib/notifications.ts`) each gain a push send alongside their existing `sendEmail` call — same trigger points, same call sites, no new event plumbing:
- Match: `"You've got a new match!"` / body prompts opening the app; `url: '/matches'`.
- Message: `"New message on Wavelengthz"` / no message content in the payload (privacy — matches the existing email's approach of not quoting message text); `url: '/messages'`.

Both send to every `push_subscriptions` row for that `user_id` (not just one device). A send that reports `expired: true` deletes that specific row; failures on other rows for the same user are unaffected (isolated per-row, same "one bad row doesn't block the rest" pattern already used by `sendDelayedMatchNotificationEmails`'s per-match error isolation).

## Frontend

- **Settings toggle** (`public/settings.html`/`settings.js`): a new "Enable notifications" row, analogous to the existing `hasSpotify`-gated Spotify block. Reflects actual current permission/subscription state (`Notification.permission` + whether an active `pushManager` subscription exists) rather than a separate stored preference — the browser's own state *is* the source of truth here. Nothing is requested automatically on page load; the toggle is the only path to `Notification.requestPermission()`.
  - **On**: request permission → if granted, `registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: <converted VAPID public key>})` → POST to `/api/push/subscribe`.
  - **Off**: `pushManager.getSubscription()` → `.unsubscribe()` → POST `/api/push/unsubscribe`.
  - If `Notification.permission === 'denied'` already (a prior dismissal), show a short explainer that it's blocked at the browser level instead of re-showing a toggle that can't do anything — browsers give exactly one shot at the permission prompt per origin.
- **iOS install banner**: shown when `window.navigator.standalone === false` (or the equivalent `display-mode: standalone` media query fails) *and* the UA indicates iOS Safari — since `Notification`/`PushManager` are undefined entirely in a non-installed iOS Safari tab, feature-detecting their absence plus the iOS UA check is how this is distinguished from "not supported at all" (old Android WebView, etc.). Explains the manual Share → "Add to Home Screen" steps (iOS has no `beforeinstallprompt`-style programmatic install API, unlike Android). Dismissible, not shown again once dismissed (localStorage flag) or once installed.
- **`public/sw.js`**: adds
  - `push` listener: parses `event.data.json()`, calls `self.registration.showNotification(title, {body, icon: '/icons/icon-192.png', data: {url}})`.
  - `notificationclick` listener: closes the notification, `clients.openWindow(event.notification.data.url)` (or focuses an existing tab at that URL, matching whatever's simplest against this SW's existing `clients.claim()` setup).

## Config

- New secrets (`wrangler secret put`, never committed, added to `src/env.d.ts`): `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:` contact address VAPID's spec requires).
- New plain var (`wrangler.toml`'s `[vars]` — not secret, the frontend receives it directly): `VAPID_PUBLIC_KEY`.
- Both keys are generated once (a short one-off script or `openssl`/`crypto.subtle` snippet — exact command lands in the implementation plan) and stored the same way local vs. production as the existing Spotify/Google credentials: `.dev.vars` for local dev, `wrangler secret put` for the production private key.

## Testing

Matches this repo's existing Vitest + `@cloudflare/vitest-pool-workers` conventions throughout:
- `test/lib/webPush.test.ts`: encryption/JWT correctness against RFC 8291/8292 test vectors (not just round-trip self-consistency — a bug that's symmetric in both encrypt and "decrypt for the test" would otherwise hide).
- `test/routes/push.test.ts`: subscribe/unsubscribe auth-gating, upsert-by-endpoint behavior, deletion scoped to the current user only.
- Extends `test/lib/notifications.test.ts`: `notifyMatch`/`notifyMessage` call the push send for every subscription row on that user, and an `expired: true` result deletes only that row.
- `npx vitest run` and `npx tsc --noEmit` clean, per this repo's acceptance bar for every task.

---

## Plan 2 — Native App + Store Distribution (future, roadmap only)

Not an implementation plan — most of this is external account setup, which can't be TDD'd. Captured as an independent roadmap doc (`docs/superpowers/plans/2026-08-09-native-app-roadmap.md`) with one-line, any-order-except-noted backlog items:

1. Apple Developer Program enrollment — **Individual** account recommended (no DUNS, $99/yr) unless there's a specific reason to publish under a company name. **Organization** accounts are the only path requiring a DUNS number, and obtaining one (if the business doesn't already have one) can take days to weeks — deferred entirely unless actually needed.
2. Google Play Console signup ($25 one-time; no DUNS requirement on either Google account tier).
3. Wrap the existing PWA with Capacitor (or equivalent) for native iOS/Android shells.
4. Wire APNs (iOS) + FCM (Android) as a second notification-send path, reusing the same `notifyMatch`/`notifyMessage` trigger points as Plan 1's Web Push.
5. Store listings, screenshots, privacy-policy updates, and (specifically for a dating app) App Store's safety-feature review — blocking/reporting already exist in-app.

A single line pointing at that roadmap doc gets added to GitHub issue #2, rather than duplicating the detail there.
