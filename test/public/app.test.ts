import { describe, it, expect, vi } from 'vitest';
import { api } from '../../public/app.js';

describe('api client', () => {
  it('api.me() fetches /api/me and returns parsed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 })));
    const result = await api.me();
    expect(result.user.id).toBe('u1');
    expect(fetch).toHaveBeenCalledWith('/api/me', expect.objectContaining({ credentials: 'include' }));
    vi.unstubAllGlobals();
  });

  it('api.candidates(mode) hits the right endpoint per mode', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.candidates('music', 5);
    expect(fetchMock).toHaveBeenCalledWith('/api/candidates/music?limit=5', expect.anything());
    await api.candidates('people');
    expect(fetchMock).toHaveBeenCalledWith('/api/candidates/people?limit=10', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.swipe posts to the mode-specific swipe endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.swipe('people', { target_id: 'u2', direction: 'right' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/swipe/people',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ target_id: 'u2', direction: 'right' }) })
    );
    vi.unstubAllGlobals();
  });

  it('api.swipeHistory appends &direction= only when a direction is given', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ swipes: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.swipeHistory('music', 20, 0);
    expect(fetchMock).toHaveBeenCalledWith('/api/swipes/music?limit=20&offset=0', expect.anything());
    await api.swipeHistory('music', 20, 0, 'right');
    expect(fetchMock).toHaveBeenCalledWith('/api/swipes/music?limit=20&offset=0&direction=right', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.matchDetail(matchId) hits the single-match endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ match: {}, overlap: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.matchDetail('m1');
    expect(fetchMock).toHaveBeenCalledWith('/api/matches/m1', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.artistProfile(id) hits the artist detail endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ artist: {}, tracks: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.artistProfile('a1');
    expect(fetchMock).toHaveBeenCalledWith('/api/artists/a1', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.artistSearch(q) hits the search endpoint with an encoded query', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.artistSearch('taylor swift');
    expect(fetchMock).toHaveBeenCalledWith('/api/artists/search?q=taylor%20swift', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.personProfile(userId) hits the people-profile endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ profile: {}, overlap: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.personProfile('u2');
    expect(fetchMock).toHaveBeenCalledWith('/api/people/u2/profile', expect.anything());
    vi.unstubAllGlobals();
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(api.me()).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
