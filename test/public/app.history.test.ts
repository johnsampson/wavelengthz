import { describe, it, expect, vi } from 'vitest';
import { api } from '../../public/app.js';

describe('api client — history and photo methods', () => {
  it('api.swipeHistory builds the right query string', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ swipes: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.swipeHistory('music', 20, 10);
    expect(fetchMock).toHaveBeenCalledWith('/api/swipes/music?limit=20&offset=10', expect.anything());
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

  it('api.photoUploadUrl posts the content type and size', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ uploadUrl: 'https://x', photoId: 'p1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.photoUploadUrl({ contentType: 'image/jpeg', sizeBytes: 1000 });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/photos',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 1000 }) })
    );
    vi.unstubAllGlobals();
  });
});
