import { describe, it, expect } from 'vitest';
import { resolveSwipeDirection } from '../../public/swipe.js';

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
