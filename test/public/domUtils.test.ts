import { describe, it, expect, vi, afterEach } from 'vitest';
import { raf, focusAfterReveal, revealAndFocusSync } from '../../public/domUtils.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('raf', () => {
  it('calls through requestAnimationFrame when it exists', () => {
    const rafMock = vi.fn((fn: () => void) => fn());
    vi.stubGlobal('requestAnimationFrame', rafMock);
    const fn = vi.fn();

    raf(fn);

    expect(rafMock).toHaveBeenCalledWith(fn);
    expect(fn).toHaveBeenCalled();
  });

  it('falls back to an immediate call when requestAnimationFrame is undefined', () => {
    // True in this test pool (@cloudflare/vitest-pool-workers has no
    // browser globals at all) -- the fallback this exists for.
    vi.stubGlobal('requestAnimationFrame', undefined);
    const fn = vi.fn();

    raf(fn);

    expect(fn).toHaveBeenCalled();
  });
});

describe('focusAfterReveal', () => {
  it('focuses the element after nextTick and a frame', () => {
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => fn());
    const nextTick = (fn: () => void) => fn();
    const el = { focus: vi.fn() };

    focusAfterReveal(nextTick, el);

    expect(el.focus).toHaveBeenCalled();
  });

  it('does not throw when the ref is not yet mounted', () => {
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => fn());
    const nextTick = (fn: () => void) => fn();

    expect(() => focusAfterReveal(nextTick, null)).not.toThrow();
    expect(() => focusAfterReveal(nextTick, undefined)).not.toThrow();
  });

  it('waits for nextTick before focusing, not before', () => {
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => fn());
    const el = { focus: vi.fn() };
    let tickCallback: (() => void) | null = null;
    const nextTick = (fn: () => void) => {
      tickCallback = fn;
    };

    focusAfterReveal(nextTick, el);
    expect(el.focus).not.toHaveBeenCalled();

    tickCallback!();
    expect(el.focus).toHaveBeenCalled();
  });
});

describe('revealAndFocusSync', () => {
  it('sets the overlay display and focuses the input, both synchronously', () => {
    const overlayEl = { style: { display: 'none' } };
    const inputEl = { focus: vi.fn() };

    revealAndFocusSync(overlayEl, inputEl);

    expect(overlayEl.style.display).toBe('');
    expect(inputEl.focus).toHaveBeenCalled();
  });

  it('does not throw when the overlay ref is not yet mounted', () => {
    const inputEl = { focus: vi.fn() };

    expect(() => revealAndFocusSync(null, inputEl)).not.toThrow();
    expect(() => revealAndFocusSync(undefined, inputEl)).not.toThrow();
    expect(inputEl.focus).toHaveBeenCalledTimes(2);
  });

  it('does not throw when the input ref is not yet mounted', () => {
    const overlayEl = { style: { display: 'none' } };

    expect(() => revealAndFocusSync(overlayEl, null)).not.toThrow();
    expect(() => revealAndFocusSync(overlayEl, undefined)).not.toThrow();
    expect(overlayEl.style.display).toBe('');
  });
});
