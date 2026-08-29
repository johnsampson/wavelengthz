import { vibrate } from './tapFeedback.js';

export function resolveSwipeDirection(deltaX, thresholdPx) {
  if (deltaX > thresholdPx) return 'right';
  if (deltaX < -thresholdPx) return 'left';
  return null;
}

export function attachSwipeDeck(container, { onSwipe, onTap = () => {}, thresholdPx = 80, tapThresholdPx = 10 }) {
  let startX = 0;
  let currentX = 0;
  let dragging = false;

  // A previous card may have been dismissed via drag, which leaves this same
  // DOM node (Alpine reuses #card in place rather than recreating it) with a
  // fully off-screen `transform` from `settle()`. Without this reset, every
  // subsequent card -- dragged or dismissed via the accessible Like/Pass
  // buttons -- would render permanently invisible off-screen.
  container.style.transition = '';
  container.style.transform = '';

  function onPointerDown(e) {
    dragging = true;
    startX = e.clientX;
    container.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!dragging) return;
    currentX = e.clientX - startX;
    container.style.transform = `translateX(${currentX}px) rotate(${currentX / 20}deg)`;
  }

  function settle(direction) {
    if (direction) {
      // installTapFeedback's site-wide haptic (public/tapFeedback.js) only
      // fires on a 'click' event -- a completed drag never dispatches one,
      // so swiping to a decision was the one way to like/pass with zero
      // haptic feedback (issue #127) even though tapping the same Like/Pass
      // buttons already vibrates. Fired here, on commit, not in onSwipe
      // itself, so it lands with the fling rather than 250ms later.
      vibrate();
      const flungX = direction === 'right' ? window.innerWidth : -window.innerWidth;
      container.style.transition = 'transform 0.25s ease-out';
      container.style.transform = `translateX(${flungX}px) rotate(${flungX / 20}deg)`;
      setTimeout(() => onSwipe(direction), 250);
    } else {
      container.style.transition = 'transform 0.2s ease-out';
      container.style.transform = 'translateX(0) rotate(0)';
    }
    setTimeout(() => {
      container.style.transition = '';
    }, 260);
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    const direction = resolveSwipeDirection(currentX, thresholdPx);
    settle(direction);
    // A genuine tap (near-zero movement, not a swipe that committed and not
    // an aborted drag that just snaps back) -- issue #145 (Round 7): "make
    // the entire artist card clickable to the profile, not just the artist
    // name". `tapThresholdPx` is deliberately far below `thresholdPx`: an
    // in-between drag (the user tried to swipe but didn't cross the
    // threshold) stays a no-op, same as before this, rather than surprising
    // them with a navigation they didn't ask for.
    if (!direction && Math.abs(currentX) <= tapThresholdPx) onTap?.();
    currentX = 0;
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerUp);

  return () => {
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerup', onPointerUp);
    container.removeEventListener('pointercancel', onPointerUp);
  };
}
