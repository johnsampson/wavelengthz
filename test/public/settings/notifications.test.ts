import { describe, it, expect, vi } from 'vitest';
import { createNotificationsApp } from '../../../public/settings/notifications.js';

function stubApi() {
  const calls: Array<{ path: string; options: any }> = [];
  const fetchMock = vi.fn(async (path: string, options: any = {}) => {
    calls.push({ path, options });
    if (path === '/api/me') return new Response(JSON.stringify({ user: {} }), { status: 200 });
    if (path === '/api/push/vapid-public-key') {
      return new Response(JSON.stringify({ publicKey: 'BC-IIfT4yho1Lp9x06rIRv0bo-Ns2hq77fpxI61ELRF2DQm0TxTLnyzHcWd2QRB6vJyJIN1gGG8In355vJGGF5E' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

function fakeServiceWorker(subscription: Record<string, unknown> | null) {
  const sub = subscription && typeof subscription.toJSON !== 'function'
    ? { ...subscription, toJSON: () => ({ endpoint: subscription.endpoint, keys: subscription.keys ?? { p256dh: 'p', auth: 'a' } }) }
    : subscription;
  return {
    ready: Promise.resolve({
      pushManager: {
        getSubscription: async () => sub,
        subscribe: async () => ({
          endpoint: 'https://push.example/new',
          toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }),
        }),
      },
    }),
  };
}

describe('notifications page', () => {
  it('init() detects an existing subscription as pushEnabled and re-subscribes to re-point ownership', async () => {
    const { calls } = stubApi();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows)',
      serviceWorker: fakeServiceWorker({ endpoint: 'https://push.example/existing', keys: { p256dh: 'p1', auth: 'a1' } }),
    });
    vi.stubGlobal('Notification', { permission: 'granted' });

    const app = createNotificationsApp();
    await app.init();

    expect(app.pushSupported).toBe(true);
    expect(app.pushEnabled).toBe(true);
    const subscribeCall = calls.find((c) => c.path === '/api/push/subscribe');
    expect(subscribeCall).toBeTruthy();
    expect(JSON.parse(subscribeCall!.options.body)).toEqual({ endpoint: 'https://push.example/existing', keys: { p256dh: 'p1', auth: 'a1' } });

    vi.unstubAllGlobals();
  });

  it('enablePush() requests permission, subscribes, and posts the subscription', async () => {
    const { calls } = stubApi();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows)', serviceWorker: fakeServiceWorker(null) });
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' });

    const app = createNotificationsApp();
    await app.init();
    await app.enablePush();

    expect(app.pushEnabled).toBe(true);
    const subscribeCall = calls.find((c) => c.path === '/api/push/subscribe')!;
    expect(JSON.parse(subscribeCall.options.body)).toEqual({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } });

    vi.unstubAllGlobals();
  });

  it('enablePush() sets pushPermissionDenied and does not subscribe when permission is denied', async () => {
    const { calls } = stubApi();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows)', serviceWorker: fakeServiceWorker(null) });
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'denied' });

    const app = createNotificationsApp();
    await app.init();
    await app.enablePush();

    expect(app.pushEnabled).toBe(false);
    expect(app.pushPermissionDenied).toBe(true);
    expect(calls.some((c) => c.path === '/api/push/subscribe')).toBe(false);

    vi.unstubAllGlobals();
  });

  it('disablePush() unsubscribes and posts the endpoint to /api/push/unsubscribe', async () => {
    const { calls } = stubApi();
    const unsubscribe = vi.fn(async () => true);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows)',
      serviceWorker: fakeServiceWorker({ endpoint: 'https://push.example/existing', unsubscribe }),
    });
    vi.stubGlobal('Notification', { permission: 'granted' });

    const app = createNotificationsApp();
    await app.init();
    await app.disablePush();

    expect(unsubscribe).toHaveBeenCalled();
    expect(app.pushEnabled).toBe(false);
    const unsubCall = calls.find((c) => c.path === '/api/push/unsubscribe')!;
    expect(JSON.parse(unsubCall.options.body)).toEqual({ endpoint: 'https://push.example/existing' });

    vi.unstubAllGlobals();
  });

  it('shows the iOS install banner only on non-standalone iOS Safari, and hides it once dismissed', async () => {
    const store: Record<string, string> = {};
    stubApi();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });

    const app = createNotificationsApp();
    await app.init();
    expect(app.showIosInstallBanner).toBe(true);

    app.dismissIosInstallBanner();
    expect(app.showIosInstallBanner).toBe(false);

    const app2 = createNotificationsApp();
    await app2.init();
    expect(app2.showIosInstallBanner).toBe(false);

    vi.unstubAllGlobals();
  });

  it('redirects to /login instead of showing an error when /api/me is unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const fakeWindow = { location: { href: '' }, matchMedia: () => ({ matches: false }) };
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows)' });

    const app = createNotificationsApp();
    await app.init();

    expect(fakeWindow.location.href).toBe('/login');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('does not show the iOS install banner on Android', async () => {
    stubApi();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14)' });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });

    const app = createNotificationsApp();
    await app.init();
    expect(app.showIosInstallBanner).toBe(false);

    vi.unstubAllGlobals();
  });
});
