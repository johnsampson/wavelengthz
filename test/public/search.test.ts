import { describe, it, expect, vi } from 'vitest';
import { shouldSearch, debounce, loadStoredMode, storeMode, saveSearchState, takeSearchState } from '../../public/search.js';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

describe('shouldSearch', () => {
  it('requires at least 3 non-whitespace characters', () => {
    expect(shouldSearch('')).toBe(false);
    expect(shouldSearch('ab')).toBe(false);
    expect(shouldSearch('abc')).toBe(true);
  });

  it('trims whitespace before counting', () => {
    expect(shouldSearch('  ab  ')).toBe(false);
    expect(shouldSearch('  abc  ')).toBe(true);
  });
});

describe('debounce', () => {
  it('only calls the wrapped function once after the delay, using the last call\'s args', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('a');
    debounced('b');
    debounced('c');
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');

    vi.useRealTimers();
  });

  it('fires again for a call made after the delay has already elapsed', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('a');
    vi.advanceTimersByTime(300);
    debounced('b');
    vi.advanceTimersByTime(300);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, 'a');
    expect(fn).toHaveBeenNthCalledWith(2, 'b');

    vi.useRealTimers();
  });
});

describe('loadStoredMode', () => {
  it('defaults to people when nothing is stored', () => {
    expect(loadStoredMode(fakeStorage())).toBe('people');
  });

  it('returns music when that was the last stored value', () => {
    expect(loadStoredMode(fakeStorage({ wl_deck_mode: 'music' }))).toBe('music');
  });

  it('falls back to people for any unexpected stored value, not just the exact literal "people"', () => {
    expect(loadStoredMode(fakeStorage({ wl_deck_mode: 'garbage' }))).toBe('people');
  });
});

describe('storeMode', () => {
  it('persists the given mode so a later loadStoredMode call picks it up', () => {
    const storage = fakeStorage();
    storeMode(storage, 'music');
    expect(loadStoredMode(storage)).toBe('music');
  });
});

describe('saveSearchState / takeSearchState', () => {
  // Regression: selecting a search result navigates away to /artist?id=...
  // (a real page load, not an SPA route), which tears down the deck's
  // Alpine component and its in-memory searchQuery/searchResults entirely.
  // Without this handoff, the browser's back button (or anything else that
  // returns to the deck) always landed back on a closed search with
  // nothing remembered -- this pair is what lets it reopen instead.
  it('round-trips the saved query and results', () => {
    const storage = fakeStorage();
    saveSearchState(storage, { query: 'drake', results: [{ id: 'a1', name: 'Drake' }] });
    expect(takeSearchState(storage)).toEqual({ query: 'drake', results: [{ id: 'a1', name: 'Drake' }] });
  });

  it('returns null, without throwing, when nothing was ever saved', () => {
    expect(takeSearchState(fakeStorage())).toBeNull();
  });

  it('consumes the saved state -- a second read after the first returns null', () => {
    // So a search only reopens automatically for the one return trip it
    // belongs to, not on every unrelated later visit to the deck within
    // the same browser session.
    const storage = fakeStorage();
    saveSearchState(storage, { query: 'drake', results: [] });

    const first = takeSearchState(storage);
    const second = takeSearchState(storage);

    expect(first).toEqual({ query: 'drake', results: [] });
    expect(second).toBeNull();
  });

  it('returns null instead of throwing for a corrupted (non-JSON) stored entry', () => {
    const storage = fakeStorage({ wl_deck_search: 'not valid json{' });
    expect(takeSearchState(storage)).toBeNull();
  });

  it('returns null for a validly-parsed but wrong-shaped stored entry', () => {
    const storage = fakeStorage({ wl_deck_search: JSON.stringify({ query: 123, results: 'not-an-array' }) });
    expect(takeSearchState(storage)).toBeNull();
  });
});
