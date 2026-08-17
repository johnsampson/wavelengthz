import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHistoryApp, loadStoredHistoryMode, PAGE_SIZE } from '../../public/history.js';
import { showErrorToast } from '../../public/toast.js';

vi.mock('../../public/toast.js', () => ({ showErrorToast: vi.fn() }));

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear();
});

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

function stubSwipeHistoryPages(pages: Record<string, any[]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      calls.push(path);
      const url = new URL(path, 'http://localhost');
      const lastSegment = url.pathname.split('/').pop()!;
      // 'artist'/'track' history both hit /api/swipes/music, distinguished
      // by item_type (see app.js's swipeHistory) -- resolve the test's mode
      // key from that query param, not the URL path, when it's present.
      const mode = url.searchParams.get('item_type') ?? lastSegment;
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const direction = url.searchParams.get('direction') ?? 'all';
      const swipes = pages[`${mode}:${offset}:${direction}`] ?? pages[`${mode}:${offset}`] ?? [];
      return new Response(JSON.stringify({ swipes }), { status: 200 });
    })
  );
  return calls;
}

function page(n: number, start: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `s${start + i}`, direction: 'right' }));
}

describe('history page pagination', () => {
  it('starts at offset 0 and has no previous page', async () => {
    stubSwipeHistoryPages({ 'people:0': page(PAGE_SIZE, 0) });
    const app = createHistoryApp();

    await app.load();

    expect(app.offset).toBe(0);
    expect(app.hasPrev).toBe(false);
  });

  it('flags hasNext when a full page comes back, and not when the page is short', async () => {
    stubSwipeHistoryPages({ 'people:0': page(PAGE_SIZE, 0) });
    const full = createHistoryApp();
    await full.load();
    expect(full.hasNext).toBe(true);

    stubSwipeHistoryPages({ 'people:0': page(3, 0) });
    const short = createHistoryApp();
    await short.load();
    expect(short.hasNext).toBe(false);
  });

  it('next() advances the offset by PAGE_SIZE and reloads', async () => {
    const calls = stubSwipeHistoryPages({
      'people:0': page(PAGE_SIZE, 0),
      [`people:${PAGE_SIZE}`]: page(4, PAGE_SIZE),
    });
    const app = createHistoryApp();
    await app.load();

    await app.next();

    expect(app.offset).toBe(PAGE_SIZE);
    expect(app.swipes.map((s: any) => s.id)).toEqual(page(4, PAGE_SIZE).map((s) => s.id));
    expect(calls.some((c) => c.includes(`offset=${PAGE_SIZE}`))).toBe(true);
  });

  it('scrolls to the top when navigating to the next or previous page', async () => {
    stubSwipeHistoryPages({
      'people:0': page(PAGE_SIZE, 0),
      [`people:${PAGE_SIZE}`]: page(4, PAGE_SIZE),
    });
    const scrollTo = vi.fn();
    vi.stubGlobal('window', { scrollTo });
    const app = createHistoryApp();
    await app.load();

    await app.next();
    expect(scrollTo).toHaveBeenCalledTimes(1);

    await app.prev();
    expect(scrollTo).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it('prev() steps back by PAGE_SIZE and never goes below 0', async () => {
    stubSwipeHistoryPages({
      'people:0': page(PAGE_SIZE, 0),
      [`people:${PAGE_SIZE}`]: page(PAGE_SIZE, PAGE_SIZE),
    });
    const app = createHistoryApp();
    await app.load();
    await app.next();
    expect(app.offset).toBe(PAGE_SIZE);

    await app.prev();
    expect(app.offset).toBe(0);
    expect(app.hasPrev).toBe(false);

    await app.prev(); // already at 0 -- must not go negative or refetch needlessly
    expect(app.offset).toBe(0);
  });

  it('does not advance past the last page', async () => {
    stubSwipeHistoryPages({ 'people:0': page(3, 0) }); // short page -- no next
    const app = createHistoryApp();
    await app.load();
    expect(app.hasNext).toBe(false);

    await app.next();

    expect(app.offset).toBe(0);
  });

  it('resets to offset 0 when switching modes', async () => {
    stubSwipeHistoryPages({
      'people:0': page(PAGE_SIZE, 0),
      [`people:${PAGE_SIZE}`]: page(PAGE_SIZE, PAGE_SIZE),
      'artist:0': page(2, 0),
    });
    const app = createHistoryApp();
    await app.load();
    await app.next();
    expect(app.offset).toBe(PAGE_SIZE);

    await app.setMode('artist');

    expect(app.mode).toBe('artist');
    expect(app.offset).toBe(0);
  });

  it('requests item_type=track (not a literal /api/swipes/track route) for the Tracks tab', async () => {
    const calls = stubSwipeHistoryPages({ 'track:0': page(2, 0) });
    const app = createHistoryApp();

    await app.setMode('track');

    expect(app.swipes).toHaveLength(2);
    expect(calls.some((c) => c.startsWith('/api/swipes/music?') && c.includes('item_type=track'))).toBe(true);
  });

  it('a direct load() failure (the initial page-mount call) sets the inline error, not a toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createHistoryApp();

    await app.load();

    expect(app.error).toBeTruthy();
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it('a load failure triggered by switching tabs growls a toast, not the inline error', async () => {
    stubSwipeHistoryPages({ 'people:0': page(2, 0) });
    const app = createHistoryApp();
    await app.load();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await app.setMode('artist');

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('swipe history'));
    expect(app.error).toBeNull();
  });

  it('a load failure triggered by paging growls a toast, not the inline error', async () => {
    stubSwipeHistoryPages({ 'people:0': page(PAGE_SIZE, 0) });
    const app = createHistoryApp();
    await app.load();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await app.next();

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('swipe history'));
    expect(app.error).toBeNull();
  });

  it('toggle() growls an error toast and leaves the direction unchanged on failure', async () => {
    stubSwipeHistoryPages({ 'people:0': page(1, 0) });
    const app = createHistoryApp();
    await app.load();
    const swipe = app.swipes[0] as any;
    const originalDirection = swipe.direction;

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await app.toggle(swipe);

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('update that swipe'));
    expect(swipe.direction).toBe(originalDirection);
  });

  it('toggle() flips the direction on success', async () => {
    const calls = stubSwipeHistoryPages({ 'people:0': page(1, 0) });
    const app = createHistoryApp();
    await app.load();
    const swipe = app.swipes[0] as any;
    expect(swipe.direction).toBe('right');

    await app.toggle(swipe);

    expect(swipe.direction).toBe('left');
    expect(calls.some((c) => c.includes(`/api/swipes/people/${swipe.id}`))).toBe(true);
  });
});

describe('history page direction filter', () => {
  it('defaults to no filter (all)', async () => {
    stubSwipeHistoryPages({ 'people:0:all': page(2, 0) });
    const app = createHistoryApp();

    await app.load();

    expect(app.directionFilter).toBeNull();
    expect(app.swipes).toHaveLength(2);
  });

  it('setDirectionFilter passes the filter through and resets offset to 0', async () => {
    stubSwipeHistoryPages({
      'people:0:all': page(PAGE_SIZE, 0),
      [`people:${PAGE_SIZE}:all`]: page(3, PAGE_SIZE),
      'people:0:right': page(2, 100),
    });
    const app = createHistoryApp();
    await app.load();
    await app.next();
    expect(app.offset).toBe(PAGE_SIZE);

    await app.setDirectionFilter('right');

    expect(app.directionFilter).toBe('right');
    expect(app.offset).toBe(0);
    expect(app.swipes.map((s: any) => s.id)).toEqual(page(2, 100).map((s) => s.id));
  });

  it('setDirectionFilter(null) clears back to showing everything', async () => {
    stubSwipeHistoryPages({
      'people:0:right': page(1, 0),
      'people:0:all': page(5, 0),
    });
    const app = createHistoryApp();
    await app.setDirectionFilter('right');
    expect(app.swipes).toHaveLength(1);

    await app.setDirectionFilter(null);

    expect(app.directionFilter).toBeNull();
    expect(app.swipes).toHaveLength(5);
  });
});

describe('history page blocked view', () => {
  function stubBlocks(blocks: Array<{ userId: string; displayName: string | null }>) {
    const calls: Array<{ path: string; options: any }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, options: any = {}) => {
        calls.push({ path, options });
        if (path === '/api/blocks') return new Response(JSON.stringify({ blocks }), { status: 200 });
        if (path.match(/^\/api\/blocks\/.+\/unblock$/)) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        throw new Error(`unexpected ${path}`);
      })
    );
    return calls;
  }

  it('loads blocked users instead of swipe history when the filter is "blocked"', async () => {
    stubBlocks([{ userId: 'u2', displayName: 'Blocked User' }]);
    const app = createHistoryApp();

    await app.setDirectionFilter('blocked');

    expect(app.swipes).toEqual([{ id: 'u2', name: 'Blocked User', direction: 'blocked' }]);
    expect(app.hasNext).toBe(false);
  });

  it('unblock() calls the API and removes the row from the list', async () => {
    stubBlocks([
      { userId: 'u2', displayName: 'Blocked User' },
      { userId: 'u3', displayName: 'Another Blocked User' },
    ]);
    const app = createHistoryApp();
    await app.setDirectionFilter('blocked');

    await app.unblock(app.swipes[0]);

    expect(app.swipes.map((s: any) => s.id)).toEqual(['u3']);
  });

  it('growls an error toast and keeps the row when unblock fails', async () => {
    const calls = stubBlocks([{ userId: 'u2', displayName: 'Blocked User' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        calls.push({ path, options: {} });
        if (path === '/api/blocks') return new Response(JSON.stringify({ blocks: [{ userId: 'u2', displayName: 'Blocked User' }] }), { status: 200 });
        return new Response('nope', { status: 500 });
      })
    );
    const app = createHistoryApp();
    await app.setDirectionFilter('blocked');

    await app.unblock(app.swipes[0]);

    expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining('unblock'));
    expect(app.swipes).toHaveLength(1);
  });

  it('resets the blocked filter back to null when switching to the Artists tab', async () => {
    stubBlocks([{ userId: 'u2', displayName: 'Blocked User' }]);
    const app = createHistoryApp();
    await app.setDirectionFilter('blocked');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => new Response(JSON.stringify({ swipes: [] }), { status: 200 }))
    );
    await app.setMode('artist');

    expect(app.directionFilter).toBeNull();
  });
});

describe('loadStoredHistoryMode', () => {
  it('defaults to people when nothing is stored', () => {
    expect(loadStoredHistoryMode(fakeStorage())).toBe('people');
  });

  it('accepts a previously stored artist or track mode', () => {
    expect(loadStoredHistoryMode(fakeStorage({ wl_history_mode: 'artist' }))).toBe('artist');
    expect(loadStoredHistoryMode(fakeStorage({ wl_history_mode: 'track' }))).toBe('track');
  });

  it('falls back to people for any unexpected stored value', () => {
    expect(loadStoredHistoryMode(fakeStorage({ wl_history_mode: 'garbage' }))).toBe('people');
  });
});

describe('history mode persistence', () => {
  // Regression: this page used to hardcode `mode: 'people'` on every fresh
  // load, so a previously-selected Artists/Tracks tab never stuck across a
  // page reload or a link back into History.
  it('starts on a previously-stored mode instead of always defaulting to people', () => {
    const app = createHistoryApp(fakeStorage({ wl_history_mode: 'artist' }));
    expect(app.mode).toBe('artist');
  });

  it('persists the mode across instances once switched', async () => {
    stubSwipeHistoryPages({ 'people:0': page(1, 0), 'artist:0': page(1, 0) });
    const storage = fakeStorage();
    const app = createHistoryApp(storage);
    expect(app.mode).toBe('people'); // nothing stored yet

    await app.setMode('artist');

    const reloaded = createHistoryApp(storage);
    expect(reloaded.mode).toBe('artist');
  });
});

describe('history totals (issue #2)', () => {
  function stubHistory(swipes: any[], total: number | undefined) {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      return new Response(JSON.stringify({ swipes, total }), { status: 200 });
    }));
  }

  it('labels the total with the noun for the current tab', async () => {
    stubHistory([{ id: 's1' }], 143);
    const app = createHistoryApp(fakeStorage({ wl_history_mode: 'artist' }));

    await app.load();

    expect(app.total).toBe(143);
    expect(app.totalLabel).toBe('143 artists');
  });

  it('singularizes a count of one', async () => {
    stubHistory([{ id: 's1' }], 1);
    const app = createHistoryApp(fakeStorage({ wl_history_mode: 'track' }));

    await app.load();

    expect(app.totalLabel).toBe('1 song');
  });

  it('uses each tab own noun', async () => {
    stubHistory([], 4);
    const people = createHistoryApp(fakeStorage({ wl_history_mode: 'people' }));
    await people.load();
    expect(people.totalLabel).toBe('4 people');

    const tracks = createHistoryApp(fakeStorage({ wl_history_mode: 'track' }));
    await tracks.load();
    expect(tracks.totalLabel).toBe('4 songs');
  });

  it('shows nothing rather than a misleading zero before the first load', () => {
    const app = createHistoryApp(fakeStorage({ wl_history_mode: 'artist' }));

    expect(app.total).toBeNull();
    expect(app.totalLabel).toBe('');
  });

  it('reports zero honestly once loaded', async () => {
    stubHistory([], 0);
    const app = createHistoryApp(fakeStorage({ wl_history_mode: 'artist' }));

    await app.load();

    expect(app.totalLabel).toBe('0 artists');
  });

  it('pages exactly on the total rather than guessing from a full page', async () => {
    // The old heuristic offered Next whenever a page came back full, so a
    // total that was an exact multiple of the page size landed the user on
    // an empty list.
    stubHistory(new Array(20).fill(0).map((_, i) => ({ id: `s${i}` })), 20);
    const app = createHistoryApp(fakeStorage({ wl_history_mode: 'artist' }));

    await app.load();

    expect(app.hasNext).toBe(false);
  });

  it('still offers the next page when there genuinely is more', async () => {
    stubHistory(new Array(20).fill(0).map((_, i) => ({ id: `s${i}` })), 45);
    const app = createHistoryApp(fakeStorage({ wl_history_mode: 'artist' }));

    await app.load();

    expect(app.hasNext).toBe(true);
  });

  it('falls back to the old heuristic if a cached client gets no total', async () => {
    stubHistory(new Array(20).fill(0).map((_, i) => ({ id: `s${i}` })), undefined);
    const app = createHistoryApp(fakeStorage({ wl_history_mode: 'artist' }));

    await app.load();

    expect(app.hasNext).toBe(true);
    expect(app.totalLabel).toBe('');
  });
});
