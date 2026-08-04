import { describe, it, expect, vi } from 'vitest';
import { getAuthedUser } from '../../public/auth.js';

describe('getAuthedUser', () => {
  it('returns the user when /api/me succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 })));
    const user = await getAuthedUser();
    expect(user).toEqual({ id: 'u1' });
    vi.unstubAllGlobals();
  });

  it('returns null when /api/me responds 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })));
    const user = await getAuthedUser();
    expect(user).toBeNull();
    vi.unstubAllGlobals();
  });

  it('rethrows on a non-401 failure instead of treating it as logged-out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Internal Server Error', { status: 500 })));
    await expect(getAuthedUser()).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
