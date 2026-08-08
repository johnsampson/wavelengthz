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
// someone from their photos/bio before ever matching.
const CACHE_NAME = 'wavelengthz-shell-v19';
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
const BYPASS_PATHS = new Set(['/login', '/callback', '/logout']);

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
