import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWavelengthApp } from '../../public/wavelength.js';

beforeEach(() => {
  vi.unstubAllGlobals();
});

const BASE = { windowDays: 30, likesInWindow: 12, rising: [], falling: [], insufficientData: false };

function stub(drift: any) {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
    return new Response(JSON.stringify(drift), { status: 200 });
  }));
  vi.stubGlobal('window', { location: { href: '', search: '' } });
}

describe('wavelength page', () => {
  it('names the genre the user moved toward', async () => {
    stub({ ...BASE, rising: [{ genre: 'ambient', current: 8, previous: 1, change: 7 }] });
    const app = createWavelengthApp();

    await app.init();

    expect(app.headline).toBe('Your wavelength moved toward ambient this month.');
    expect(app.loading).toBe(false);
  });

  it('falls back to what they are playing less of when nothing rose', async () => {
    stub({ ...BASE, falling: [{ genre: 'punk', current: 0, previous: 9, change: -9 }] });
    const app = createWavelengthApp();

    await app.init();

    expect(app.headline).toContain('less punk');
  });

  it('says taste held steady when neither list has anything', async () => {
    stub(BASE);
    const app = createWavelengthApp();

    await app.init();

    expect(app.headline).toBe('Your wavelength held steady this month.');
  });

  it('says nothing at all when there is not enough listening to support a claim', async () => {
    // A confident sentence built on two swipes is what makes this kind of
    // feature feel invented. The page shows its own explanatory state instead.
    stub({ ...BASE, likesInWindow: 1, insufficientData: true, rising: [{ genre: 'ambient', current: 1, previous: 0, change: 1 }] });
    const app = createWavelengthApp();

    await app.init();

    expect(app.headline).toBe('');
  });

  it('signs the delta so it reads as movement rather than a total', () => {
    const app = createWavelengthApp();

    expect(app.delta({ change: 4 })).toBe('+4');
    expect(app.delta({ change: -4 })).toBe('-4');
  });

  it('surfaces an error and stops loading when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
      return new Response('nope', { status: 500 });
    }));
    vi.stubGlobal('window', { location: { href: '', search: '' } });
    const app = createWavelengthApp();

    await app.init();

    expect(app.error).toBeTruthy();
    expect(app.loading).toBe(false);
  });
});
