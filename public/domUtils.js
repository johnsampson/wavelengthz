// Tiny DOM-adjacent helpers used by more than one page module. Kept
// deliberately minimal -- this is not a general utility dumping ground, just
// the couple of things that would otherwise be copy-pasted.

/**
 * requestAnimationFrame, falling back to an immediate call when it isn't
 * defined -- true in this repo's test pool (test/public/*.ts run under
 * @cloudflare/vitest-pool-workers, which has no `document`/browser globals
 * at all), and a reasonable fallback in any other non-browser context this
 * code might load in. Every real caller runs in an actual browser, where
 * requestAnimationFrame always exists and the fallback branch never fires.
 */
export function raf(fn) {
  return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : fn();
}

/**
 * Focus an element after Alpine has actually revealed it, in a way that
 * keeps working on iOS Safari.
 *
 * The two-step reason (issue #108: "search bar focus dies not open keyboard
 * without a 2nd click"): a plain `.focus()` on a still `display:none`
 * element is a no-op, so callers already had to wait for Alpine's own
 * `$nextTick` before focusing. But `$nextTick` resolves via a microtask, and
 * iOS Safari does not reliably treat a `.focus()` call still stuck behind a
 * microtask -- with a layout-affecting DOM change (the display toggle
 * itself) interleaved before it -- as still linked to the tap that
 * triggered it, so the keyboard silently fails to open. The *next* tap
 * (now on an already-visible input, no intervening layout change) works,
 * which is exactly the "needs a second click" symptom reported.
 * requestAnimationFrame keeps the focus() call inside the browser's
 * gesture-linked paint pipeline instead of a bare microtask.
 *
 * `nextTick` is Alpine's own `$nextTick`, passed in rather than imported --
 * this module has no Alpine dependency of its own.
 *
 * @param {(fn: () => void) => void} nextTick
 * @param {{ focus: () => void } | null | undefined} el
 */
export function focusAfterReveal(nextTick, el) {
  nextTick(() => raf(() => el?.focus()));
}
