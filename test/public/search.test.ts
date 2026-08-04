import { describe, it, expect, vi } from 'vitest';
import { shouldSearch, debounce } from '../../public/search.js';

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
