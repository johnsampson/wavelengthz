import { describe, it, expect } from 'vitest';
import { resolveSwipeDirection, attachSwipeDeck } from '../../public/swipe.js';

describe('resolveSwipeDirection', () => {
  it('returns null below the threshold', () => {
    expect(resolveSwipeDirection(20, 80)).toBeNull();
    expect(resolveSwipeDirection(-20, 80)).toBeNull();
  });
  it('returns right past the positive threshold', () => {
    expect(resolveSwipeDirection(120, 80)).toBe('right');
  });
  it('returns left past the negative threshold', () => {
    expect(resolveSwipeDirection(-120, 80)).toBe('left');
  });
});

// A minimal stand-in for the real #card element. attachSwipeDeck only needs
// `style` (a plain object is fine) and addEventListener/removeEventListener
// off the container -- it never touches anything else, so this avoids
// needing a real DOM (unavailable in the workerd test environment).
function fakeCardElement() {
  return {
    style: { transform: '', transition: '' } as Record<string, string>,
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
  };
}

describe('attachSwipeDeck', () => {
  it('clears a leftover transform/transition from a previous drag-dismissed card on attach', () => {
    const container = fakeCardElement();
    // Simulate the state settle() leaves behind after a drag-driven swipe:
    // fully off-screen and mid-transition. Since showNext() re-attaches to
    // the same static #card node for every new candidate, this state must
    // not leak into the next card -- including one dismissed via the
    // keyboard-operable Like/Pass buttons, which never touch style.transform
    // themselves.
    container.style.transform = 'translateX(390px) rotate(19.5deg)';
    container.style.transition = 'transform 0.25s ease-out';

    attachSwipeDeck(container, { onSwipe: () => {} });

    expect(container.style.transform).toBe('');
    expect(container.style.transition).toBe('');
  });
});
