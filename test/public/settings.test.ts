import { describe, it, expect, vi } from 'vitest';
import { createSettingsApp } from '../../public/settings.js';

function stubApi(user: Record<string, unknown>) {
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/api/me') return new Response(JSON.stringify({ user }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
}

describe('settings hub', () => {
  it('loads the caller\'s own id so the preview-profile link can use it', async () => {
    stubApi({ id: 'u1' });
    const app = createSettingsApp();
    expect(app.userId).toBeNull();

    await app.init();

    expect(app.userId).toBe('u1');
    expect(app.loading).toBe(false);
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('surfaces an error and stops loading when /api/me fails on init', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createSettingsApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('redirects to /login instead of showing an error when /api/me is unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createSettingsApp();

    await app.init();

    expect(fakeWindow.location.href).toBe('/login');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('logs out and lands on the deck (not /login, which would silently re-trigger Spotify OAuth)', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/logout') return new Response('ok', { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createSettingsApp();

    await app.logout();

    expect(fetchMock).toHaveBeenCalledWith('/logout', expect.objectContaining({ method: 'POST' }));
    expect(fakeWindow.location.href).toBe('/');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('surfaces an error and does not redirect when the logout request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createSettingsApp();

    await app.logout();

    expect(fakeWindow.location.href).toBe('');
    expect(app.error).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
