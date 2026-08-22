// Site-wide client-side navigation: intercepts clicks on same-origin links
// to a "routed" page and swaps its content in place instead of letting the
// browser do a full reload -- the only way anything living outside the
// swapped region (public/playerBar.js's fixed bar, chief among them) can
// survive from one page to the next. See the plan this was built from for
// the full design rationale.
//
// Import this module purely for its side effects (installs the click/
// popstate listeners below) -- each routed page's own bootstrap script does
// `import '/router.js'` alongside its `import { mountHeader, mountNav } from
// './nav.js'` etc. ES module import caching means this only ever runs once
// per document no matter how many pages import it.
import { mountHeader, mountNav } from './nav.js';

// Kept in sync BY HAND with public/sw.js's own BYPASS_PATHS -- sw.js is a
// classic (non-module) script and can't import this file, and this file has
// no way to import sw.js either, so this list is duplicated rather than
// shared. The reasoning is identical to sw.js's: these are a third-party
// OAuth handshake with Spotify/Google, not a page this app renders, and
// letting a client-side fetch()+DOMParser cycle stand in for the real
// top-level navigation would mangle the redirect chain the same way sw.js's
// own comment describes.
export const BYPASS_PATHS = new Set(['/login', '/login/spotify', '/login/google', '/callback', '/callback/google', '/logout']);

// One entry per page migrated onto the `<div id="wl-app-root" x-data=
// "pageApp()">` shape -- grows across several PRs (see the plan's staging).
// A pathname that isn't a key here always falls through to a real, full
// navigation: this table is the single switch between "routed" and "not yet
// routed" for any given page, so a not-yet-migrated page (still `x-data` on
// `<body>`) is never at risk of being swapped incorrectly.
export const ROUTES = {
  '/': { module: '/index.js', factory: 'createDeckApp' },
  '/artist': { module: '/artist.js', factory: 'createArtistApp' },
  '/profile': { module: '/personProfile.js', factory: 'createPersonProfileApp' },
  '/settings': { module: '/settings.js', factory: 'createSettingsApp' },
  '/settings/profile': { module: '/settings/profile.js', factory: 'createProfileApp' },
  '/settings/messaging': { module: '/settings/messaging.js', factory: 'createMessagingApp' },
  '/settings/preferences': { module: '/settings/preferences.js', factory: 'createPreferencesApp' },
  '/settings/notifications': { module: '/settings/notifications.js', factory: 'createNotificationsApp' },
  '/settings/connections': { module: '/settings/connections.js', factory: 'createConnectionsApp' },
  '/history': { module: '/history.js', factory: 'createHistoryApp' },
  '/wavelength': { module: '/wavelength.js', factory: 'createWavelengthApp' },
  '/drop': { module: '/drop.js', factory: 'createDropApp' },
  '/matches': { module: '/matches.js', factory: 'createMatchesApp' },
  '/match': { module: '/match.js', factory: 'createMatchApp' },
  '/groups': { module: '/groups.js', factory: 'createGroupsApp' },
  '/notifications': { module: '/notifications.js', factory: 'createNotificationsApp' },
  '/messages': { module: '/messages.js', factory: 'createMessagesApp' },
  '/group': { module: '/group.js', factory: 'createGroupApp' },
};

export function resolveRoute(pathname) {
  return ROUTES[pathname] ?? null;
}

// Pure -- takes a plain options object rather than a real MouseEvent/anchor
// element so this is unit-testable without a DOM (this test pool has none
// anywhere in test/public/*.ts). Mirrors the standard checklist every
// client-side router needs before hijacking a click: non-primary clicks,
// modifier-held clicks (open in new tab/window), target="_blank", rel=
// "external", and `download` links all need to fall through to the
// browser's own handling completely untouched.
export function shouldInterceptClick(opts) {
  if (opts.defaultPrevented) return false;
  if (opts.button !== 0) return false;
  if (opts.metaKey || opts.ctrlKey || opts.shiftKey || opts.altKey) return false;
  if (!opts.sameOrigin) return false;
  if (opts.targetAttr && opts.targetAttr !== '_self') return false;
  if (opts.rel === 'external') return false;
  if (opts.hasDownloadAttr) return false;
  if (BYPASS_PATHS.has(opts.pathname)) return false;
  if (!resolveRoute(opts.pathname)) return false;
  return true;
}

// Bumped on every navigate() call and checked again after each await --
// lets a second, later click "win" over a still-in-flight earlier one
// instead of the two racing to decide what the final page looks like (e.g.
// double-tapping History then Settings before History's fetch resolves).
// The superseded fetch is simply left to finish and discarded; not worth an
// AbortController for what's normally a same-origin, same-service-worker
// request.
let navToken = 0;

// The untested glue step of this module (DOM swapping, fetch, import()) --
// this test pool has no `document`/`fetch` anywhere in test/public/*.ts, so
// this is deliberately exercised only manually (see the plan's checklist),
// same split as nav.js's mountNav/mountHeader vs. its own render* functions.
export async function navigate(url, { push = true } = {}) {
  const token = ++navToken;
  const targetUrl = new URL(url, window.location.href);
  const route = resolveRoute(targetUrl.pathname);
  if (!route) {
    // Callers (onClick/onPopState below) only ever pass an already-resolved
    // pathname, so this shouldn't happen -- but fail soft to a real
    // navigation rather than leave the page stuck mid-swap if it ever does.
    window.location.href = url;
    return;
  }

  let res;
  try {
    // Same-origin GET to a precached route -- hits sw.js's existing
    // cache-first fetch handler for anything in APP_SHELL with no special
    // casing needed here.
    res = await fetch(url);
    if (!res.ok) throw new Error(`bad status ${res.status}`);
  } catch (e) {
    if (token === navToken) window.location.href = url; // fail soft to a real navigation
    return;
  }
  if (token !== navToken) return; // superseded by a later navigate() while this fetch was in flight

  const html = await res.text();
  if (token !== navToken) return;

  // Fail soft, same as the fetch above. An import() rejection here (a stale
  // service-worker cache missing a newly-added module, a chunk that 404s mid-
  // deploy) would otherwise reject navigate() -- and onClick calls it without
  // awaiting or catching, so the rejection would surface as an unhandled
  // promise and the app would simply sit there having done nothing visible.
  let mod;
  try {
    mod = await import(route.module);
  } catch (e) {
    if (token === navToken) window.location.href = url;
    return;
  }
  if (token !== navToken) return;

  const oldRoot = document.getElementById('wl-app-root');
  // Optional per-page teardown hook (poll intervals, swipe-deck pointer
  // listeners, ...) a page's factory can define -- see the plan's lifecycle
  // hooks section. Most pages don't need one and simply don't define it.
  window.Alpine?.$data(oldRoot)?.destroy?.();

  // Assigned before the new root enters the DOM, matching every routed
  // page's own first-load bootstrap ordering (script before the deferred
  // alpine.js) -- Alpine's MutationObserver mustn't ever find `x-data=
  // "pageApp()"` on a freshly-inserted node before `window.pageApp` exists.
  window.pageApp = mod[route.factory];

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const newRoot = document.importNode(doc.getElementById('wl-app-root'), true);
  // A genuinely new element, not an innerHTML mutation -- Alpine only binds
  // x-data/x-init on nodes its MutationObserver sees inserted, never on one
  // whose innerHTML merely changed underneath it (confirmed with a manual
  // spike before writing this). The fetched document's own dormant
  // #wl-header-root/#wl-player-root/#wl-nav-root copies are simply
  // discarded here -- the live document's real ones are never touched.
  oldRoot.replaceWith(newRoot);

  mountHeader();
  mountNav(targetUrl.pathname);
  // mountPlayerBar() is deliberately NOT called here -- it mounts once, at
  // boot, from each page's bootstrap script, since its content and state
  // are route-independent and it lives outside #wl-app-root entirely.

  document.title = doc.title;
  if (push) window.history.pushState({}, '', url);
  window.scrollTo(0, 0);
}

function onClick(e) {
  // The CURRENT page has to be routed too, not just the destination --
  // resolveRoute/shouldInterceptClick only ever look at where a link
  // points, so without this a click on an unmigrated page (still `x-data`
  // on `<body>`, no #wl-app-root at all) toward an already-migrated one
  // would pass every check and then crash inside navigate() trying to
  // replaceWith() a null oldRoot. Falling through to a real navigation here
  // is exactly what should happen anyway until every page is migrated.
  if (!document.getElementById('wl-app-root')) return;
  const anchor = e.target.closest('a');
  if (!anchor || !anchor.href) return;
  const url = new URL(anchor.href, window.location.href);
  const intercept = shouldInterceptClick({
    pathname: url.pathname,
    sameOrigin: url.origin === window.location.origin,
    targetAttr: anchor.target,
    rel: anchor.rel,
    hasDownloadAttr: anchor.hasAttribute('download'),
    button: e.button,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    defaultPrevented: e.defaultPrevented,
  });
  if (!intercept) return;
  e.preventDefault();
  navigate(anchor.href);
}

function onPopState() {
  navigate(window.location.pathname + window.location.search, { push: false });
}

// Guarded rather than unconditional: this module runs both as a real
// browser module (where document/window always exist) and, for its pure
// exports (resolveRoute/shouldInterceptClick), under this project's
// Workers-runtime test environment (test/public/router.test.ts), which has
// neither global at all -- same guard shape as history.js's scrollToTop.
if (typeof document !== 'undefined') {
  document.addEventListener('click', onClick);
  window.addEventListener('popstate', onPopState);
}
