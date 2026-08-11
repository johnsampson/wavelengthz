import { describe, it, expect, vi } from 'vitest';
import { createHistoryApp, PAGE_SIZE } from '../../public/history.js';

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

  it('surfaces an error and keeps the row when unblock fails', async () => {
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

    expect(app.error).toBeTruthy();
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
