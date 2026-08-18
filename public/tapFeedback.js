// Site-wide tap feedback ("we need more button feedback... highlight items
// when clicked"). Two separate, pre-existing problems, both fixed by this
// one module -- no per-button changes needed anywhere else in the app.
//
// 1. This app already defines active:scale-*/active:bg-* Tailwind utilities
//    on nearly everything tappable (.btn-primary/.btn-secondary/.btn-ghost/
//    .btn-danger, .pill-toggle, nav.js's tab bar and header bell, a handful
//    of one-off cards). But iOS Safari has a long-documented WebKit quirk:
//    :active pseudo-class styles never apply on a plain tap unless *some*
//    touch event listener is registered somewhere on the page -- any
//    element, any handler, doesn't matter which. Its mere presence is what
//    "arms" :active recognition for touch input. Nothing in this app ever
//    registered one, so every one of those already-authored active: states
//    has silently never fired on iOS.
// 2. Tailwind's own Preflight sets -webkit-tap-highlight-color: transparent
//    globally, which kills the native gray tap flash too. Between #1 and
//    #2, a tap on iOS currently produces zero visual feedback of any kind.
//
// installTapFeedback()'s touchstart listener alone fixes both, retroactively,
// for every element already carrying an active: class across the whole app.
//
// It also fires a short haptic buzz via the Vibration API on a genuine
// button tap. Honest platform limitation, not a bug to chase further:
// Safari -- iOS and macOS both -- has never implemented the Vibration API at
// all; navigator.vibrate is undefined there. So this is a silent no-op on
// iOS specifically, which is the platform "the iOS equivalent vibration" was
// actually asked about -- there is no way to reach iOS's Taptic Engine from
// web content, PWA or not. Native apps reach it through a private framework
// (UIImpactFeedbackGenerator) this app has no access to. Android Chrome and
// most other Android browsers do implement the Vibration API, so this is
// real, working feedback there, and a harmless no-op everywhere it isn't.

// Elements this app already styles as tappable buttons. Deliberately not
// every <a> -- vibrating on every plain nav/text link tap would turn
// ordinary navigation into a buzz-fest; scoped to the elements that already
// carry button-like affordance.
const TAP_TARGET_SELECTOR = 'button, [role="button"], .pill-toggle, a.btn-primary, a.btn-secondary, a.btn-ghost, a.btn-danger';

// A light "tap" buzz, deliberately much shorter than the 200ms used for an
// incoming-message notification (messages.js/group.js) -- that one needs to
// be felt as an attention-grabbing alert; this one just confirms a touch
// landed, closer to a native button's own haptic click.
export const TAP_VIBRATE_MS = 10;

/**
 * Pure: whether a tap on this element should fire haptic feedback. Takes
 * anything with a `closest` method so it's testable without a real DOM.
 */
export function isTapTarget(el) {
  return !!el?.closest?.(TAP_TARGET_SELECTOR);
}

let installed = false;

/**
 * Called once, at boot, from every page's bootstrap script (mirrors
 * mountPlayerBar()'s own guard/rationale) -- guarded so it stays a no-op on
 * repeat calls, relevant since the router re-runs each destination page's
 * bootstrap on every client-side navigation.
 */
export function installTapFeedback() {
  if (installed) return;
  installed = true;

  // The handler itself does nothing -- registering it at all is what
  // unlocks :active on iOS. { passive: true } so it can never block
  // scrolling or add tap latency.
  document.addEventListener('touchstart', () => {}, { passive: true });

  if (!navigator.vibrate) return; // nothing else to do where the API doesn't exist (iOS, notably)
  document.addEventListener(
    'click',
    (e) => {
      if (isTapTarget(e.target)) navigator.vibrate(TAP_VIBRATE_MS);
    },
    { passive: true }
  );
}

// Test-only: mirrors playerBar.js's/wavelengthzPlayer.js's own
// _resetForTests -- the `installed` guard above is a deliberate page-lifetime
// singleton, which would otherwise leak between independent test cases
// sharing this module instance. Not called anywhere outside
// test/public/tapFeedback.test.ts.
export function _resetForTests() {
  installed = false;
}
