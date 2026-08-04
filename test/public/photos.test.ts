import { describe, it, expect, vi } from 'vitest';
import { MAX_PHOTOS, uploadPhotoFile } from '../../public/photos.js';

describe('MAX_PHOTOS', () => {
  it('is 10', () => {
    expect(MAX_PHOTOS).toBe(10);
  });
});

describe('uploadPhotoFile', () => {
  function fakeFile(type = 'image/jpeg', size = 1000) {
    return { type, size, name: 'photo.jpg' };
  }

  it('posts the file bytes with its content type and returns the photo id and servable url', async () => {
    const fetchMock = vi.fn(async (url, options) => {
      if (url === '/api/photos') return new Response(JSON.stringify({ photoId: 'p1', url: '/photos/p1' }), { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = fakeFile();
    const result = await uploadPhotoFile(file);

    expect(result).toEqual({ photoId: 'p1', url: '/photos/p1' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/photos',
      expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: file })
    );
    vi.unstubAllGlobals();
  });

  it('throws with status and parsed body on a non-2xx JSON error response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'too_many_photos' }), { status: 400 })));

    let caught: any;
    try {
      await uploadPhotoFile(fakeFile());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(400);
    expect(caught.body).toEqual({ error: 'too_many_photos' });
    vi.unstubAllGlobals();
  });

  it('throws with a null body on a non-2xx non-JSON error response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    let caught: any;
    try {
      await uploadPhotoFile(fakeFile());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(500);
    expect(caught.body).toBeNull();
    vi.unstubAllGlobals();
  });
});
