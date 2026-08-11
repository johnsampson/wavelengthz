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
    await api.swipeHistory('people', 20, 0);
    expect(fetchMock).toHaveBeenCalledWith('/api/swipes/people?limit=20&offset=0', expect.anything());
    await api.swipeHistory('people', 20, 0, 'right');
    expect(fetchMock).toHaveBeenCalledWith('/api/swipes/people?limit=20&offset=0&direction=right', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.swipeHistory routes "artist"/"track" to /api/swipes/music with an item_type param -- there is no /api/swipes/artist or /api/swipes/track route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ swipes: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.swipeHistory('artist', 20, 0);
    expect(fetchMock).toHaveBeenCalledWith('/api/swipes/music?limit=20&offset=0&item_type=artist', expect.anything());
    await api.swipeHistory('track', 20, 0, 'right');
    expect(fetchMock).toHaveBeenCalledWith('/api/swipes/music?limit=20&offset=0&direction=right&item_type=track', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.updateSwipe routes "artist"/"track" to the /api/swipes/music/:id PATCH endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.updateSwipe('artist', 'sw1', 'right');
    expect(fetchMock).toHaveBeenCalledWith('/api/swipes/music/sw1', expect.objectContaining({ method: 'PATCH' }));
    await api.updateSwipe('people', 'sw2', 'left');
    expect(fetchMock).toHaveBeenCalledWith('/api/swipes/people/sw2', expect.objectContaining({ method: 'PATCH' }));
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

  it('api.artistProfile(id, limit) appends ?limit= for the "Load more songs" case', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ artist: {}, tracks: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.artistProfile('a1', 60);
    expect(fetchMock).toHaveBeenCalledWith('/api/artists/a1?limit=60', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.artistSearch(q) hits the search endpoint with an encoded query', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.artistSearch('taylor swift');
    expect(fetchMock).toHaveBeenCalledWith('/api/artists/search?q=taylor%20swift', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.createArtist(spotifyArtistId) POSTs to /api/artists', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, artistId: 'internal-uuid' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.createArtist('spotify-artist-1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/artists',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ spotifyArtistId: 'spotify-artist-1' }) })
    );
    vi.unstubAllGlobals();
  });

  it('api.personProfile(userId) hits the people-profile endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ profile: {}, overlap: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.personProfile('u2');
    expect(fetchMock).toHaveBeenCalledWith('/api/people/u2/profile', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.notifications() hits the notifications list endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ notifications: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.notifications();
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.markNotificationRead(id) POSTs to the read endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.markNotificationRead('n1');
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications/n1/read', expect.objectContaining({ method: 'POST' }));
    vi.unstubAllGlobals();
  });

  it('api.blocks() hits the blocks list endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ blocks: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.blocks();
    expect(fetchMock).toHaveBeenCalledWith('/api/blocks', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.unblock(userId) POSTs to the unblock endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.unblock('u2');
    expect(fetchMock).toHaveBeenCalledWith('/api/blocks/u2/unblock', expect.objectContaining({ method: 'POST' }));
    vi.unstubAllGlobals();
  });

  it('api.groups() hits the groups list endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ groups: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.groups();
    expect(fetchMock).toHaveBeenCalledWith('/api/groups', expect.anything());
    vi.unstubAllGlobals();
  });

  it('api.createGroup(name, topic) POSTs name and topic', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, groupId: 'g1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.createGroup('Indie Fans', 'indie rock');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/groups',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Indie Fans', topic: 'indie rock' }) })
    );
    vi.unstubAllGlobals();
  });

  it('api.joinGroup/leaveGroup hit the right endpoints', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.joinGroup('g1');
    expect(fetchMock).toHaveBeenCalledWith('/api/groups/g1/join', expect.objectContaining({ method: 'POST' }));
    await api.leaveGroup('g1');
    expect(fetchMock).toHaveBeenCalledWith('/api/groups/g1/leave', expect.objectContaining({ method: 'POST' }));
    vi.unstubAllGlobals();
  });

  it('api.sendGroupMessage(groupId, body) POSTs to the group messages endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.sendGroupMessage('g1', 'hello');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/groups/g1/messages',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ body: 'hello' }) })
    );
    vi.unstubAllGlobals();
  });

  it('api.recallMessage(matchId, messageId) POSTs to the recall endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.recallMessage('m1', 'msg1');
    expect(fetchMock).toHaveBeenCalledWith('/api/matches/m1/messages/msg1/recall', expect.objectContaining({ method: 'POST' }));
    vi.unstubAllGlobals();
  });

  it('api.recallGroupMessage(groupId, messageId) POSTs to the group recall endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.recallGroupMessage('g1', 'msg1');
    expect(fetchMock).toHaveBeenCalledWith('/api/groups/g1/messages/msg1/recall', expect.objectContaining({ method: 'POST' }));
    vi.unstubAllGlobals();
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(api.me()).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
