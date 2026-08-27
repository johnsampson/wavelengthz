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

/**
 * Reveal an `x-show`'d overlay and focus an input inside it, both
 * synchronously, in the same call stack as the tap that triggered it.
 *
 * issue #127 item 7 reported the exact same "click search, keyboard
 * doesn't open on iPhone" symptom `focusAfterReveal` above (issue #108) was
 * already supposed to have fixed -- six days after that fix shipped. The
 * difference: `focusAfterReveal` still waits for Alpine's own `$nextTick`
 * (a microtask) plus a full animation frame before calling `.focus()`.
 * That's the whole reason `$nextTick` exists -- Alpine batches its
 * reactive DOM updates (including the `style.display` toggle `x-show`
 * does) behind a microtask rather than applying them inline -- but it
 * means the actual `.focus()` call lands two ticks removed from the
 * original click. iOS Safari's window for still treating a deferred
 * `.focus()` as linked to a real tap (and so allowed to open the
 * keyboard) is apparently narrower than even that fits inside for some
 * users/iOS versions, even though it holds up in this app's own manual
 * testing against a real device.
 *
 * This closes that gap by not going through Alpine's reactivity for the
 * reveal at all: it sets `overlayEl.style.display` directly (the same
 * property `x-show` itself would eventually set) and calls `.focus()`,
 * both plain synchronous DOM calls with zero ticks between them and the
 * click. Alpine's own `x-show` effect still runs afterward once its
 * state update flushes -- harmless, since by then the display is already
 * correct and it's a no-op.
 *
 * Only usable when the caller holds a direct ref to the exact element
 * `x-show` toggles (not just the input inside it) -- use
 * `focusAfterReveal` instead where that ref isn't available, or where the
 * extra two ticks of margin haven't caused a problem in practice.
 *
 * @param {{ style: { display: string } } | null | undefined} overlayEl
 * @param {{ focus: () => void } | null | undefined} inputEl
 */
export function revealAndFocusSync(overlayEl, inputEl) {
  if (overlayEl) overlayEl.style.display = '';
  inputEl?.focus();
}
