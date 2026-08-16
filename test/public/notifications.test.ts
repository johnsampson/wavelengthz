import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNotificationsApp } from '../../public/notifications.js';
import { navigate } from '../../public/router.js';

vi.mock('../../public/router.js', () => ({ navigate: vi.fn() }));

beforeEach(() => {
  vi.mocked(navigate).mockClear();
});

function stubApi(handler: (path: string, options?: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => handler(path, options)));
}

describe('notifications list', () => {
  it('loads notifications on init when authed', async () => {
    stubApi((path) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      if (path === '/api/notifications')
        return new Response(JSON.stringify({ notifications: [{ id: 'n1', type: 'match', readAt: null }] }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const app = createNotificationsApp();

    await app.init();

    expect(app.notifications).toEqual([{ id: 'n1', type: 'match', readAt: null }]);
    vi.unstubAllGlobals();
  });

  it('marks an unread notification read and navigates for a match', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/notifications/n1/read') return new Response('{}', { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createNotificationsApp();
    const n = { id: 'n1', matchId: 'm1', readAt: null as number | null };

    await app.open(n);

    expect(fetchMock).toHaveBeenCalledWith('/api/notifications/n1/read', expect.objectContaining({ method: 'POST' }));
    expect(n.readAt).toEqual(expect.any(Number));
    expect(navigate).toHaveBeenCalledWith('/match?id=m1');
    vi.unstubAllGlobals();
  });

  it('still navigates even if marking read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createNotificationsApp();
    const n = { id: 'n1', matchId: 'm1', readAt: null as number | null };

    await app.open(n);

    expect(navigate).toHaveBeenCalledWith('/match?id=m1');
    vi.unstubAllGlobals();
  });

  it('does not navigate for a notification with no matchId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const app = createNotificationsApp();
    const n = { id: 'n1', matchId: null, readAt: Date.now() };

    await app.open(n);

    expect(navigate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
