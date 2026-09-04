// Issue #173 (Round 8): "Add loading icons on lost api calls. When on a
// [slow] connection, [it's] not clear things are loading." A single global
// choke point rather than instrumenting every call site individually --
// public/app.js's shared `request()` helper calls beginRequest()/endRequest()
// around every fetch, so any API call, anywhere in the app, that's slow
// (or genuinely lost -- stuck with no response) makes this visible without
// each page having to opt in.
//
// A thin bar fixed to the top of the viewport, GitHub/YouTube-style, rather
// than a full-screen spinner or overlay -- most in-flight requests here
// happen alongside content that's already on screen (a swipe, a send, a
// track search), so blocking the view would be worse than the silence this
// is meant to fix.
const SHOW_DELAY_MS = 500; // long enough that a normal fast round trip never flashes it

let activeCount = 0;
let showTimer = null;
let bar = null;

function ensureBar() {
  if (bar && document.body.contains(bar)) return bar;
  bar = document.createElement('div');
  bar.id = 'wl-loading-bar';
  bar.hidden = true;
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-label', 'Loading');
  bar.className = 'pointer-events-none fixed inset-x-0 top-0 z-50 h-1 animate-pulse bg-gradient-to-r from-brand-500 to-accent-500';
  document.body.appendChild(bar);
  return bar;
}

// Exported for tests -- everything else here is DOM-timer plumbing that's
// only meaningful with a real document.
export function _resetForTests() {
  activeCount = 0;
  if (showTimer) clearTimeout(showTimer);
  showTimer = null;
  bar = null;
}

export function beginRequest() {
  activeCount += 1;
  if (activeCount === 1 && !showTimer) {
    showTimer = setTimeout(() => {
      showTimer = null;
      if (activeCount > 0) {
        try {
          ensureBar().hidden = false;
        } catch (e) {
          // Best-effort UI, not a functional dependency -- every fetch in
          // the app routes through app.js's request(), which calls this, so
          // an unusual page/document state here must never take down the
          // actual request it's decorating.
        }
      }
    }, SHOW_DELAY_MS);
  }
}

export function endRequest() {
  activeCount = Math.max(0, activeCount - 1);
  if (activeCount > 0) return;
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  try {
    if (bar) bar.hidden = true;
  } catch (e) {
    // See beginRequest's timer callback above.
  }
}
