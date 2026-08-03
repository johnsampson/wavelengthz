export function resolveSwipeDirection(deltaX, thresholdPx) {
  if (deltaX > thresholdPx) return 'right';
  if (deltaX < -thresholdPx) return 'left';
  return null;
}

export function attachSwipeDeck(container, { onSwipe, thresholdPx = 80 }) {
  let startX = 0;
  let currentX = 0;
  let dragging = false;

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
    settle(resolveSwipeDirection(currentX, thresholdPx));
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
