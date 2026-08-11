import { describe, it, expect, vi } from 'vitest';
import { createMessagingApp, normalizePhoneNumber } from '../../../public/settings/messaging.js';

const NOT_READY_STATUS = {
  ready: false,
  bio: { met: false, length: 0, required: 20 },
  photos: { met: false, count: 0, required: 3 },
  likedSongs: { met: false, count: 0, required: 25 },
  phone: { met: false, phoneNumber: null },
};

const READY_STATUS = {
  ready: true,
  bio: { met: true, length: 40, required: 20 },
  photos: { met: true, count: 3, required: 3 },
  likedSongs: { met: true, count: 25, required: 25 },
  phone: { met: true, phoneNumber: '+15551234567' },
};

function stubApi(status: Record<string, unknown> = NOT_READY_STATUS) {
  const calls: Array<{ path: string; options: any }> = [];
  const fetchMock = vi.fn(async (path: string, options: any = {}) => {
    calls.push({ path, options });
    if (path === '/api/me/messaging-status') return new Response(JSON.stringify(status), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

describe('normalizePhoneNumber', () => {
  it('assumes a US number and prepends +1 when there is no leading +', () => {
    expect(normalizePhoneNumber('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhoneNumber('555 123 4567')).toBe('+15551234567');
  });

  it('preserves an explicit country code and strips formatting characters', () => {
    expect(normalizePhoneNumber('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('returns an empty string for blank input, rather than a bare "+1"', () => {
    expect(normalizePhoneNumber('')).toBe('');
    expect(normalizePhoneNumber('   ')).toBe('');
  });
});

describe('messaging page', () => {
  it('loads and displays the messaging-status response on init', async () => {
    stubApi(NOT_READY_STATUS);
    const app = createMessagingApp();

    await app.init();

    expect(app.ready).toBe(false);
    expect(app.bio).toEqual(NOT_READY_STATUS.bio);
    expect(app.photos).toEqual(NOT_READY_STATUS.photos);
    expect(app.likedSongs).toEqual(NOT_READY_STATUS.likedSongs);
    expect(app.phone).toEqual(NOT_READY_STATUS.phone);
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('shows ready: true once every requirement is already met', async () => {
    stubApi(READY_STATUS);
    const app = createMessagingApp();

    await app.init();

    expect(app.ready).toBe(true);
    vi.unstubAllGlobals();
  });

  it('redirects to /login instead of showing an error when the status fetch is unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const fakeWindow = { location: { href: '' } };
    vi.stubGlobal('window', fakeWindow);
    const app = createMessagingApp();

    await app.init();

    expect(fakeWindow.location.href).toBe('/login');
    expect(app.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('surfaces an error and stops loading when the status fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createMessagingApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects sending a code for input that does not normalize to a real number, without a network call', async () => {
    const { calls } = stubApi();
    const app = createMessagingApp();
    await app.init();
    app.phoneInput = '123';

    await app.sendCode();

    expect(app.phoneError).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/phone/verify/start')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('sendCode() posts the normalized number and advances to the code step on success', async () => {
    const { calls } = stubApi();
    const app = createMessagingApp();
    await app.init();
    app.phoneInput = '(555) 123-4567';

    await app.sendCode();

    const call = calls.find((c) => c.path === '/api/phone/verify/start')!;
    expect(JSON.parse(call.options.body)).toEqual({ phoneNumber: '+15551234567' });
    expect(app.phoneStep).toBe('code');
    expect(app.pendingPhoneNumber).toBe('+15551234567');
    expect(app.phoneInfo).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('surfaces a specific error for a VOIP number, and does not advance to the code step', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/me/messaging-status') return new Response(JSON.stringify(NOT_READY_STATUS), { status: 200 });
      if (path === '/api/phone/verify/start') return new Response(JSON.stringify({ error: 'voip_not_allowed' }), { status: 400 });
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createMessagingApp();
    await app.init();
    app.phoneInput = '5551234567';

    await app.sendCode();

    expect(app.phoneError).toContain('VOIP');
    expect(app.phoneStep).toBe('entry');
    vi.unstubAllGlobals();
  });

  it('surfaces a friendly error when rate-limited', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/me/messaging-status') return new Response(JSON.stringify(NOT_READY_STATUS), { status: 200 });
      if (path === '/api/phone/verify/start') return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 });
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createMessagingApp();
    await app.init();
    app.phoneInput = '5551234567';

    await app.sendCode();

    expect(app.phoneError).toContain('too many times');
    vi.unstubAllGlobals();
  });

  it('rejects verifying a blank code, without a network call', async () => {
    const { calls } = stubApi();
    const app = createMessagingApp();
    await app.init();
    app.phoneStep = 'code';
    app.pendingPhoneNumber = '+15551234567';
    app.codeInput = '   ';

    await app.verifyCode();

    expect(app.phoneError).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/phone/verify/check')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('verifyCode() marks phone met and recomputes ready on success', async () => {
    const status = { ...NOT_READY_STATUS, bio: { met: true, length: 40, required: 20 }, photos: { met: true, count: 3, required: 3 }, likedSongs: { met: true, count: 25, required: 25 } };
    const { calls } = stubApi(status);
    const app = createMessagingApp();
    await app.init();
    app.phoneStep = 'code';
    app.pendingPhoneNumber = '+15551234567';
    app.codeInput = '123456';

    await app.verifyCode();

    const call = calls.find((c) => c.path === '/api/phone/verify/check')!;
    expect(JSON.parse(call.options.body)).toEqual({ phoneNumber: '+15551234567', code: '123456' });
    expect(app.phone).toEqual({ met: true, phoneNumber: '+15551234567' });
    expect(app.ready).toBe(true); // every other requirement was already met
    vi.unstubAllGlobals();
  });

  it('surfaces a specific error for an incorrect code, and does not mark phone met', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/me/messaging-status') return new Response(JSON.stringify(NOT_READY_STATUS), { status: 200 });
      if (path === '/api/phone/verify/check') return new Response(JSON.stringify({ error: 'invalid_code' }), { status: 400 });
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createMessagingApp();
    await app.init();
    app.phoneStep = 'code';
    app.pendingPhoneNumber = '+15551234567';
    app.codeInput = '000000';

    await app.verifyCode();

    expect(app.phoneError).toContain('incorrect');
    expect(app.phone.met).toBe(false);
    vi.unstubAllGlobals();
  });

  it('editPhoneNumber() returns to the entry step and clears in-flight state', async () => {
    stubApi();
    const app = createMessagingApp();
    await app.init();
    app.phoneStep = 'code';
    app.codeInput = '123456';
    app.phoneError = 'stale error';

    app.editPhoneNumber();

    expect(app.phoneStep).toBe('entry');
    expect(app.codeInput).toBe('');
    expect(app.phoneError).toBeNull();
    vi.unstubAllGlobals();
  });
});
