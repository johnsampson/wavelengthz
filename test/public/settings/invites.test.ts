import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInvitesApp } from '../../../public/settings/invites.js';
import { showErrorToast } from '../../../public/toast.js';

vi.mock('../../../public/toast.js', () => ({ showErrorToast: vi.fn() }));

function stubApi(invites: any[], canMintUnlimited = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/api/me/invites') return new Response(JSON.stringify({ invites, canMintUnlimited }), { status: 200 });
      return new Response('not found', { status: 404 });
    })
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(showErrorToast).mockClear();
});

const UNREDEEMED = { code: 'ABCD1234', targetGender: 'female', redeemed: false, redeemedByName: null };
const REDEEMED = { code: 'EFGH5678', targetGender: 'male', redeemed: true, redeemedByName: 'Sam' };

describe('invites page', () => {
  it('loads invites and splits them into unredeemed/redeemed', async () => {
    stubApi([UNREDEEMED, REDEEMED]);
    const app = createInvitesApp();

    await app.init();

    expect(app.loading).toBe(false);
    expect(app.unredeemed).toEqual([UNREDEEMED]);
    expect(app.redeemed).toEqual([REDEEMED]);
  });

  it('redirects to /login on a 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    vi.stubGlobal('window', { location: { href: '' } });
    const app = createInvitesApp();

    await app.init();

    expect((globalThis as any).window.location.href).toBe('/login');
  });

  it('surfaces an error and stops loading on any other failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const app = createInvitesApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
  });

  it('builds a shareable /join link from the current origin', () => {
    vi.stubGlobal('window', { location: { origin: 'https://wavelengthz.com' } });
    const app = createInvitesApp();
    expect(app.inviteUrl('ABCD1234')).toBe('https://wavelengthz.com/join?code=ABCD1234');
  });

  it('labels target gender for display', () => {
    const app = createInvitesApp();
    expect(app.genderLabel('male')).toBe('a man');
    expect(app.genderLabel('female')).toBe('a woman');
    expect(app.genderLabel(null)).toBe('anyone');
  });

  it('copies the invite link and shows a transient confirmation', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { origin: 'https://wavelengthz.com' } });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const app = createInvitesApp();

    await app.copyLink('ABCD1234');

    expect(writeText).toHaveBeenCalledWith('https://wavelengthz.com/join?code=ABCD1234');
    expect(app.copiedCode).toBe('ABCD1234');

    vi.advanceTimersByTime(2000);
    expect(app.copiedCode).toBeNull();
    vi.useRealTimers();
  });

  it('is a silent no-op when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://wavelengthz.com' } });
    vi.stubGlobal('navigator', {});
    const app = createInvitesApp();

    await expect(app.copyLink('ABCD1234')).resolves.toBeUndefined();
    expect(app.copiedCode).toBeNull();
  });

  // Issue #173 (Round 8): admin invite-minting, only ever shown to the three
  // allowlisted accounts (src/lib/inviteCodes.ts's isInviteAdmin).
  describe('canMintUnlimited / mintCodes', () => {
    it('defaults to false for a non-admin account', async () => {
      stubApi([UNREDEEMED]);
      const app = createInvitesApp();
      await app.init();
      expect(app.canMintUnlimited).toBe(false);
    });

    it('is true when the server reports canMintUnlimited', async () => {
      stubApi([], true);
      const app = createInvitesApp();
      await app.init();
      expect(app.canMintUnlimited).toBe(true);
    });

    it('mints codes and prepends them onto the existing list, no gender label', async () => {
      const fetchMock = vi.fn(async (path: string, options: any = {}) => {
        if (path === '/api/me/invites') return new Response(JSON.stringify({ invites: [UNREDEEMED], canMintUnlimited: true }), { status: 200 });
        if (path === '/api/me/invites/mint') {
          expect(JSON.parse(options.body)).toEqual({ count: 10 });
          return new Response(JSON.stringify({ codes: ['NEWCODE1', 'NEWCODE2'] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const app = createInvitesApp();
      await app.init();
      app.mintCount = 10;

      await app.mintCodes();

      expect(app.minting).toBe(false);
      expect(app.invites![0]).toEqual({ code: 'NEWCODE1', targetGender: null, redeemed: false, redeemedByName: null });
      expect(app.invites![1]).toEqual({ code: 'NEWCODE2', targetGender: null, redeemed: false, redeemedByName: null });
      expect(app.invites![2]).toEqual(UNREDEEMED);
    });

    it('rejects a non-positive count without a network call', async () => {
      stubApi([], true);
      const app = createInvitesApp();
      await app.init();
      app.mintCount = 0;

      await app.mintCodes();

      expect(showErrorToast).toHaveBeenCalled();
    });

    it('surfaces an error toast and stops minting on failure', async () => {
      const fetchMock = vi.fn(async (path: string) => {
        if (path === '/api/me/invites') return new Response(JSON.stringify({ invites: [], canMintUnlimited: true }), { status: 200 });
        if (path === '/api/me/invites/mint') return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
        return new Response('not found', { status: 404 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const app = createInvitesApp();
      await app.init();
      app.mintCount = 5;

      await app.mintCodes();

      expect(showErrorToast).toHaveBeenCalled();
      expect(app.minting).toBe(false);
    });
  });
});
