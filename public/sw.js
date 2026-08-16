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
// v29 self-hosts Alpine.js (public/alpine.js, vendored from the alpinejs npm
// package via `npm run vendor:alpine`) instead of loading it from the
// cdn.jsdelivr.net CDN on every one of the 17 pages that use it -- that CDN
// request was un-cacheable by this SW (cross-origin requests are left to the
// browser's normal fetch, see the fetch handler below) and render-blocking,
// so even an install with the rest of the shell served instantly from cache
// still had to wait on a live network round-trip before Alpine's x-init
// directives ran and the page became interactive. CSP's script-src no longer
// allow-lists cdn.jsdelivr.net (src/index.ts and public/_headers) since
// 'self' now covers it. v30 fixes the deck (/) and /history always
// defaulting to People mode on every fresh load, no matter which mode was
// last selected -- switching to Music mode never stuck across a page
// reload or the browser's back button. Also makes returning from an
// artist's page (tapped from a deck search result) reopen that same
// search instead of landing on a bare, closed deck (search.js's new
// saveSearchState/takeSearchState, wired into index.html). v31 replaces the
// 5 duplicated inline "Wavelengthz Player vs. Basic player" blocks on /,
// /artist, and /profile with one shared fixed player bar above the bottom
// nav (public/playerBar.js, new -- added to this precache list) -- also
// touches index.html/artist.html/profile.html's own markup/scripts and
// every other precached page's bottom padding (pb-24/mb-20 -> the new
// .pb-app/.mb-app utility classes in tailwind.css, which react to whether
// the bar is currently showing). v32 adds public/router.js: internal link
// clicks between any two of the 16 non-onboarding routes now swap
// #wl-app-root's content in place instead of doing a full page reload, so
// the player bar (and everything else outside #wl-app-root) survives
// navigating around the app -- the actual "keeps playing" behavior the
// fixed bar was originally built for. Every page's inline Alpine app moved
// off <body> onto <div id="wl-app-root"> and was extracted to its own
// module (index.js, artist.js, personProfile.js, matches.js, match.js,
// groups.js, notifications.js, messages.js, group.js -- all new, all added
// to this precache list, alongside router.js itself); messages.js/group.js
// additionally gained a destroy() that clears their 3s poll interval and
// audio-unlock listeners, a leak that was harmless under the old
// full-reload-per-navigation model but wouldn't have been under this one
// without it. Also fixes two long-standing gaps in this precache list
// itself -- /toast.js (used by nearly every page, never precached) and
// /wavelengthzPlayer.js (already fixed in v31, kept here since this list
// needed a full pass anyway) -- and a genuine bug on /profile: the photo
// lightbox's prev/next buttons read profile.photoUrls outside the x-if=
// "profile" guard the rest of the page uses, throwing "Cannot read
// properties of null" in the console on every load before the profile
// fetch resolved (Alpine's x-show evaluates its expression continuously
// regardless of visibility, unlike x-if). /onboarding is deliberately not
// on the router (see router.js's ROUTES) -- it's a one-time gate reached by
// redirect, not a destination anyone links to or navigates back into. v33
// is a round of player-bar feedback: taller chrome with the artist name
// shown alongside the track, a marquee that auto-scrolls a truncated
// name/artist instead of just clipping it, a neutral loading state instead
// of a "Basic player" badge flash before Premium availability resolves, a
// like button (POST /api/swipe/music, mirrored from every track row's own
// Like button), and --wl-nav-h is now measured from the real rendered nav
// (nav.js's mountNav) instead of a hardcoded estimate -- fixes a 1-2px gap
// between the player bar and the nav that let scrolled content peek
// through. Also routes several more internal navigations (deck search ->
// artist/profile, groups -> group, match unmatch/block -> matches, group
// leave -> groups) through the client-side router instead of a hard
// window.location.href reload, so playback survives them the same way it
// already did for a plain link click -- and replaces the deck/artist pages'
// swipe-left "Pass" ✕ icon with a thumbs-down glyph. v34 adds
// <link rel="manifest" href="/manifest.json"> to every page's <head> --
// previously only index.html and login.html had it, so "Add to Home
// Screen" from any other page (e.g. /settings) had no manifest to read
// start_url from and just bookmarked whatever page was currently open
// instead of installing a real app shortcut back to the deck. Anyone who
// already installed from a non-deck page needs to remove that shortcut and
// re-add it (a code fix alone can't retroactively repoint an icon that
// already exists on a home screen).
const CACHE_NAME = 'wavelengthz-shell-v34';
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
  '/toast.js',
  '/alpine.js',
  '/playerBar.js',
  '/wavelengthzPlayer.js',
  '/router.js',
  '/index.js',
  '/artist.js',
  '/personProfile.js',
  '/matches.js',
  '/match.js',
  '/groups.js',
  '/notifications.js',
  '/messages.js',
  '/group.js',
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
