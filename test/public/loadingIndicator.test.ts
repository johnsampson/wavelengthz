import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { beginRequest, endRequest, _resetForTests } from '../../public/loadingIndicator.js';

function fakeDocument() {
  const children: any[] = [];
  const body = {
    appendChild: vi.fn((el: any) => children.push(el)),
    contains: (el: any) => children.includes(el),
  };
  return {
    createElement: vi.fn(() => ({ hidden: true, setAttribute: vi.fn(), classList: { add: vi.fn() } })),
    body,
    children,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('loading indicator', () => {
  it('does not show the bar before the show-delay elapses', () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);

    beginRequest();
    vi.advanceTimersByTime(499);

    expect(doc.children).toHaveLength(0);
  });

  it('shows the bar once the show-delay elapses while a request is still in flight', () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);

    beginRequest();
    vi.advanceTimersByTime(500);

    expect(doc.children).toHaveLength(1);
    expect(doc.children[0].hidden).toBe(false);
  });

  it('never shows the bar at all for a request that finishes before the delay', () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);

    beginRequest();
    endRequest();
    vi.advanceTimersByTime(1000);

    expect(doc.children).toHaveLength(0);
  });

  it('stays visible across overlapping requests, hiding only once the last one finishes', () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);

    beginRequest();
    vi.advanceTimersByTime(500);
    beginRequest(); // a second, overlapping request starts once the bar is already up
    endRequest(); // first of the two finishes
    expect(doc.children[0].hidden).toBe(false); // still one in flight -- must stay visible

    endRequest(); // second finishes
    expect(doc.children[0].hidden).toBe(true);
  });

  // Issue #173: this is wired into app.js's shared request() helper, so
  // every single fetch in the app runs through beginRequest()/endRequest().
  // An unusual document state (this test pool's default, and conceivably a
  // real page mid-navigation) must never break the request it's decorating.
  it('never throws when document lacks the DOM APIs it expects', () => {
    vi.stubGlobal('document', {});

    expect(() => beginRequest()).not.toThrow();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(() => endRequest()).not.toThrow();
  });
});
