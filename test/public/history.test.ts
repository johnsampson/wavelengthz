import { describe, it, expect, vi } from 'vitest';
import { createHistoryApp, PAGE_SIZE } from '../../public/history.js';

function stubSwipeHistoryPages(pages: Record<string, any[]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      calls.push(path);
      const url = new URL(path, 'http://localhost');
      const mode = url.pathname.split('/').pop()!;
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
      'music:0': page(2, 0),
    });
    const app = createHistoryApp();
    await app.load();
    await app.next();
    expect(app.offset).toBe(PAGE_SIZE);

    await app.setMode('music');

    expect(app.mode).toBe('music');
    expect(app.offset).toBe(0);
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
