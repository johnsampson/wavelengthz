import { describe, it, expect, vi } from 'vitest';
import { createMatchesApp } from '../../public/matches.js';

function stubApi(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path in routes) return new Response(JSON.stringify(routes[path]), { status: 200 });
      return new Response('not found', { status: 404 });
    })
  );
}

describe('matches list', () => {
  it('loads matches on init when authed', async () => {
    stubApi({ '/api/me': { user: { id: 'u1' } }, '/api/matches': { matches: [{ id: 'm1', otherUserId: 'u2' }] } });
    const app = createMatchesApp();

    await app.init();

    expect(app.matches).toEqual([{ id: 'm1', otherUserId: 'u2' }]);
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('redirects to /login instead of loading when logged out', async () => {
    stubApi({ '/api/me': new Response('nope', { status: 401 }) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createMatchesApp();

    await app.init();

    expect(fakeWindow.location.href).toBe('/login');
    expect(app.matches).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('surfaces an error when loading matches fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      return new Response('nope', { status: 500 });
    }));
    const app = createMatchesApp();

    await app.init();

    expect(app.error).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
