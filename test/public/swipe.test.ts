import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveSwipeDirection, attachSwipeDeck } from '../../public/swipe.js';
import { vibrate } from '../../public/tapFeedback.js';

vi.mock('../../public/tapFeedback.js', () => ({ vibrate: vi.fn() }));

beforeEach(() => {
  vi.mocked(vibrate).mockClear();
});

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

// Same shape as fakeCardElement, but actually records the listeners
// attachSwipeDeck registers so a test can drive a full pointerdown ->
// pointermove -> pointerup drag through them directly.
function fakeDraggableCardElement() {
  const handlers: Record<string, (e?: any) => void> = {};
  return {
    style: { transform: '', transition: '' } as Record<string, string>,
    addEventListener(type: string, handler: (e?: any) => void) {
      handlers[type] = handler;
    },
    removeEventListener() {},
    setPointerCapture() {},
    _handlers: handlers,
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

  // Issue #127: "when I click a like button, can't it give phone vibration
  // feedback" -- installTapFeedback's site-wide haptic only fires on a
  // 'click' event, and a completed drag never dispatches one, so swiping to
  // a decision (unlike tapping the Like/Pass buttons) had no haptic at all.
  it('vibrates when a drag commits to a real swipe decision', () => {
    vi.stubGlobal('window', { innerWidth: 400 });
    const container = fakeDraggableCardElement();
    attachSwipeDeck(container, { onSwipe: () => {} });

    container._handlers['pointerdown']({ clientX: 0, pointerId: 1 });
    container._handlers['pointermove']({ clientX: 200 }); // past the 80px default threshold
    container._handlers['pointerup']();

    expect(vibrate).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('does not vibrate when a drag springs back without crossing the threshold', () => {
    vi.stubGlobal('window', { innerWidth: 400 });
    const container = fakeDraggableCardElement();
    attachSwipeDeck(container, { onSwipe: () => {} });

    container._handlers['pointerdown']({ clientX: 0, pointerId: 1 });
    container._handlers['pointermove']({ clientX: 20 }); // well under threshold
    container._handlers['pointerup']();

    expect(vibrate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // issue #145 (Round 7): "make the entire artist card clickable to the
  // profile, not just the artist name".
  describe('onTap', () => {
    it('fires on a near-zero-movement tap', () => {
      vi.stubGlobal('window', { innerWidth: 400 });
      const container = fakeDraggableCardElement();
      const onTap = vi.fn();
      attachSwipeDeck(container, { onSwipe: () => {}, onTap });

      container._handlers['pointerdown']({ clientX: 100, pointerId: 1 });
      container._handlers['pointermove']({ clientX: 103 }); // 3px, well under the 10px tap threshold
      container._handlers['pointerup']();

      expect(onTap).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });

    it('does not fire for an aborted drag that springs back without being a real tap', () => {
      vi.stubGlobal('window', { innerWidth: 400 });
      const container = fakeDraggableCardElement();
      const onTap = vi.fn();
      attachSwipeDeck(container, { onSwipe: () => {}, onTap });

      container._handlers['pointerdown']({ clientX: 0, pointerId: 1 });
      container._handlers['pointermove']({ clientX: 20 }); // under the swipe threshold, over the tap one
      container._handlers['pointerup']();

      expect(onTap).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('does not fire when the drag commits to a real swipe', () => {
      vi.stubGlobal('window', { innerWidth: 400 });
      const container = fakeDraggableCardElement();
      const onTap = vi.fn();
      attachSwipeDeck(container, { onSwipe: () => {}, onTap });

      container._handlers['pointerdown']({ clientX: 0, pointerId: 1 });
      container._handlers['pointermove']({ clientX: 200 }); // past the 80px default threshold
      container._handlers['pointerup']();

      expect(onTap).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('does not throw when onTap is not provided', () => {
      vi.stubGlobal('window', { innerWidth: 400 });
      const container = fakeDraggableCardElement();
      attachSwipeDeck(container, { onSwipe: () => {} });

      container._handlers['pointerdown']({ clientX: 0, pointerId: 1 });
      container._handlers['pointermove']({ clientX: 1 });

      expect(() => container._handlers['pointerup']()).not.toThrow();
      vi.unstubAllGlobals();
    });
  });
});
