import { describe, it, expect, vi } from 'vitest';
import { api } from '../../public/app.js';

describe('api client — history and photo methods', () => {
  it('api.swipeHistory builds the right query string', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ swipes: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.swipeHistory('people', 20, 10);
    expect(fetchMock).toHaveBeenCalledWith('/api/swipes/people?limit=20&offset=10', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.updateSwipe PATCHes the right path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.updateSwipe('people', 'swipe-1', 'right');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/swipes/people/swipe-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ direction: 'right' }) })
    );
    vi.unstubAllGlobals();
  });

  it('a non-2xx JSON error response attaches status and parsed body to the thrown error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'underage' }), { status: 403 }))
    );
    let caught: any;
    try {
      await api.onboard({ date_of_birth: '2015-01-01', location_label: 'x', lat: 1, lng: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(403);
    expect(caught.body).toEqual({ error: 'underage' });
    vi.unstubAllGlobals();
  });

  it('a non-2xx non-JSON error response still throws with a null body (no unhandled rejection)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    let caught: any;
    try {
      await api.me();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(500);
    expect(caught.body).toBeNull();
    vi.unstubAllGlobals();
  });
});
