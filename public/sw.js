// Bumped v2 -> v3 -> v4 -> v5 -> v6 -> v7 -> v8 -> v9 -> v10: v3/v4 fixed the
// CSP/connect-src issue (see below). v5 added /groups and /group to the
// precache list. v6 added the Spotify embed iframe to /artist (replacing
// the dead-preview <audio> player). v7 fixed that iframe being x-show'd
// (hidden, but still mounted and playing) instead of x-if'd (actually
// removed from the DOM). v8 makes /history's people/artist names clickable
// links back to their profile/artist page. v9: artists/tracks ids are now
// obfuscated internal UUIDs (migrations/0002_obfuscate_catalog_ids.sql) --
// /artist's embed iframe now reads track.spotifyId instead of track.id, so
// a stale cached copy would build a broken (UUID-based) embed URL. v10
// fixes selecting a not-yet-cataloged artist from Music-mode search --
// selectArtist() now POSTs it to /api/artists first instead of navigating
// straight to /artist?id=undefined. v11 adds 3s polling to /messages so new
// messages show up without a manual refresh, plus a synthesized sound and
// navigator.vibrate() when one arrives from the other person. v13 adds the
// same Spotify embed player to /profile's three track lists (top/shared/
// recent), matching /artist. v14 fixes /group's message list missing
// w-full, which let it shrink-wrap instead of matching the header/input's
// width -- messages appeared adrift in the middle of the page instead of
// filling the same column. v15 adds the same 3s polling + sound/vibrate
// notification to /group that /messages already had -- it was never
// actually ported over to group chat. v16 adds message recall (15s window)
// to both /messages and /group, and fixes /messages' client-side charset
// pre-check missing a hyphen (it disagreed with the server's regex and with
// /group's own pre-check). v17 fixes recall not showing up for the other
// participant's poll -- it only refreshed on a message-count change, and a
// recall doesn't change the count, just flips recalledAt on an existing row.
// v18 replaces /profile's photo grid with a single-image carousel (prev/next
// arrows + a shared index with the full-screen lightbox). v19 adds a Report
// button to /profile -- previously the only report entry point anywhere in
// the app was from an active match (match.html), with no way to report
// someone from their photos/bio before ever matching. v20 adds push
// notification handling (push + notificationclick listeners) -- see
// docs/superpowers/plans/2026-08-09-web-push-notifications.md. v21 fixes
// notificationclick's existing-tab match: message pushes now deep-link with
// a matchId query string, so comparing only pathname (the old check) wrongly
// treated any open /messages tab as "the same" conversation regardless of
// which match it was actually showing. v22 points push notifications' icon
// at the hosted app logo instead of the local placeholder /icons/icon-192.png.
// v23 splits /settings into four sub-pages (/settings/profile,
// /settings/preferences, /settings/notifications, /settings/connections) --
// without a cache bump, this SW's cache-first fetch handler would keep every
// already-installed user on the old pre-split /settings and /settings.js
// forever, since nothing in the fetch handler ever revalidates. v24 covers a
// batch of 7 PRs merged without bumping this, so every one of them was
// silently stuck behind the cache-first fetch handler until now: adds a Bio
// field to /settings/profile.js, locks gender read-only on
// /settings/preferences.js, adds the email-notifications toggle to
// /settings/notifications.js, makes /profile's artist chips link out,
// reorders / rewords the deck (index.html) header/empty-state and adds the
// skip button, and splits /history.js's Music tab into Artists/Tracks.
// v25 adds the new /settings/messaging sub-page (bio/photos/liked-songs/
// phone-verification checklist for unlocking messaging, issue #36 item 1
// expanded) -- a brand new precached route + its script, not just an edit
// to an existing one, so it has to be in APP_SHELL from the start or a
// first-time offline visit to it 404s. v26 fixes /artist showing the same
// opaque "Could not load this artist" for a Spotify-rate-limit failure as
// every other error -- it now shows a specific "Spotify's a little busy"
// message for that case (src/index.ts's new SpotifyRateLimitError -> 503
// translation). v27 replaces nearly every page's scroll-prone inline
// "<p x-show=error>" action-failure banner with a growl toast
// (public/toast.js's new error variant) -- touches most precached HTML/JS
// files in this list (index, artist, match, messages, group, groups,
// profile, onboarding, history.js, settings.js, and every settings/*.js
// sub-page). v28 fixes /onboarding and /settings/profile's display-name
// `pattern` attribute -- Chrome now compiles <input pattern> as a `v`-flag
// (unicodeSets) regex, which requires escaping `-` inside a character class
// even at the leading/trailing edge, unlike classic regex; the unescaped
// version threw "Invalid regular expression" in the console on every save.
const CACHE_NAME = 'wavelengthz-shell-v28';
const APP_SHELL = [
  '/',
  '/app.js',
  '/swipe.js',
  '/settings.js',
  '/nav.js',
  '/auth.js',
  '/history.js',
  '/search.js',
  '/photos.js',
  '/tailwind.css',
  '/manifest.json',
  '/onboarding',
  '/history',
  '/matches',
  '/match',
  '/artist',
  '/profile',
  '/messages',
  '/settings',
  '/settings/profile',
  '/settings/messaging',
  '/settings/preferences',
  '/settings/notifications',
  '/settings/connections',
  '/settings/profile.js',
  '/settings/messaging.js',
  '/settings/preferences.js',
  '/settings/notifications.js',
  '/settings/connections.js',
  '/notifications',
  '/groups',
  '/group',
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

// /login, /callback, and /logout are a third-party OAuth handshake with
// Spotify -- there's nothing to cache, and intercepting them is actively
// harmful: this SW takes control immediately (skipWaiting + clients.claim,
// below), so it can grab the very first navigation on a freshly-registered
// page. Once it does, its fetch() call for /login follows Spotify's 302
// *internally* (fetch()'s default redirect: 'follow') instead of letting the
// browser perform a real top-level navigation -- which silently breaks the
// oauth-state cookie round-trip and produces "Invalid OAuth state" with
// nothing to log server-side, since the request the server sees is entirely
// legitimate, just carrying a cookie from a redirect chain the SW mangled.
const BYPASS_PATHS = new Set(['/login', '/login/spotify', '/login/google', '/callback', '/callback/google', '/logout']);

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Cross-origin requests (Google Fonts, the Alpine.js CDN, Spotify's image
  // CDN, ...) are intentionally left to the browser's normal fetch entirely
  // -- letting the SW intercept and re-issue them via fetch() subjects them
  // to the page's connect-src CSP directive regardless of what kind of
  // resource they actually are (script/style/img), which doesn't match
  // reality and isn't this SW's job to cache anyway (third-party CDNs already
  // do their own caching).
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    BYPASS_PATHS.has(url.pathname)
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  const payload = event.data.json();
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: 'https://img.wavelengthz.com/wavelengthz-logo-transparent.png',
      data: { url: payload.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? '/';
  // targetUrl can now carry a query string (e.g. '/messages?matchId=...'),
  // so an already-open tab only counts as "the same page" when its
  // pathname AND search match -- comparing pathname alone (the old
  // behavior) would treat two different open matches' /messages tabs as
  // interchangeable and focus the wrong conversation.
  const target = new URL(targetUrl, self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      const existing = clients.find((c) => {
        const clientUrl = new URL(c.url);
        return clientUrl.pathname === target.pathname && clientUrl.search === target.search;
      });
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});
