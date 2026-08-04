const CACHE_NAME = 'wavelengthz-shell-v1';
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
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/') || BYPASS_PATHS.has(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
