import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { isTapTarget, installTapFeedback, TAP_VIBRATE_MS, _resetForTests } from '../../public/tapFeedback.js';

beforeEach(() => {
  _resetForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isTapTarget', () => {
  it('matches a real button element', () => {
    const el = { closest: (sel: string) => (sel.includes('button') ? el : null) };
    expect(isTapTarget(el)).toBe(true);
  });

  it('does not match an element with no button-like ancestor', () => {
    const el = { closest: () => null };
    expect(isTapTarget(el)).toBe(false);
  });

  it('does not throw for a null/undefined target', () => {
    expect(isTapTarget(null)).toBe(false);
    expect(isTapTarget(undefined)).toBe(false);
  });
});

describe('installTapFeedback', () => {
  function stubDom() {
    const listeners: Record<string, Array<(e: any) => void>> = {};
    const doc = {
      addEventListener: vi.fn((type: string, handler: (e: any) => void) => {
        (listeners[type] ??= []).push(handler);
      }),
    };
    vi.stubGlobal('document', doc);
    return { doc, listeners };
  }

  it('registers a touchstart listener so :active recognition gets armed on iOS', () => {
    const { doc } = stubDom();
    vi.stubGlobal('navigator', {});

    installTapFeedback();

    expect(doc.addEventListener).toHaveBeenCalledWith('touchstart', expect.any(Function), { passive: true });
  });

  it('is a no-op on repeat calls (mirrors mountPlayerBar\'s guard)', () => {
    const { doc } = stubDom();
    vi.stubGlobal('navigator', {});

    installTapFeedback();
    installTapFeedback();
    installTapFeedback();

    expect(doc.addEventListener.mock.calls.filter((c: any[]) => c[0] === 'touchstart')).toHaveLength(1);
  });

  it('does not register a click listener when the Vibration API is unavailable (iOS Safari)', () => {
    const { doc } = stubDom();
    vi.stubGlobal('navigator', {}); // no .vibrate -- matches real Safari

    installTapFeedback();

    expect(doc.addEventListener).not.toHaveBeenCalledWith('click', expect.any(Function), expect.anything());
  });

  it('vibrates for a tap on a button-like element when the API exists', () => {
    const { listeners } = stubDom();
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });

    installTapFeedback();
    const clickHandler = listeners['click'][0];
    const target = { closest: (sel: string) => (sel.includes('button') ? target : null) };
    clickHandler({ target });

    expect(vibrate).toHaveBeenCalledWith(TAP_VIBRATE_MS);
  });

  it('does not vibrate for a tap that lands outside any button-like element', () => {
    const { listeners } = stubDom();
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });

    installTapFeedback();
    const clickHandler = listeners['click'][0];
    const target = { closest: () => null };
    clickHandler({ target });

    expect(vibrate).not.toHaveBeenCalled();
  });
});
