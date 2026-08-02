import { describe, it, expect, vi } from 'vitest';
import { getValidAccessToken } from '../../src/lib/tokens';
import { encrypt } from '../../src/lib/crypto';

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const env = {
  TOKEN_ENCRYPTION_KEY: KEY,
  SPOTIFY_CLIENT_ID: 'id',
  SPOTIFY_CLIENT_SECRET: 'secret',
} as any;

describe('getValidAccessToken', () => {
  it('returns the decrypted token directly when not expired', async () => {
    const encAccess = await encrypt('valid-access-token', KEY);
    const encRefresh = await encrypt('refresh-token', KEY);
    const user = {
      id: 'u1',
      access_token: encAccess,
      refresh_token: encRefresh,
      token_expires_at: Date.now() + 1000 * 60 * 60,
    } as any;
    const db = { prepare: vi.fn() } as any;

    const token = await getValidAccessToken(user, env, db);
    expect(token).toBe('valid-access-token');
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('refreshes and persists new tokens when expired', async () => {
    const encAccess = await encrypt('stale-access-token', KEY);
    const encRefresh = await encrypt('refresh-token', KEY);
    const user = {
      id: 'u1',
      access_token: encAccess,
      refresh_token: encRefresh,
      token_expires_at: Date.now() - 1000,
    } as any;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access_token: 'fresh-access-token', refresh_token: 'refresh-token', expires_in: 3600 }),
          { status: 200 }
        )
      )
    );

    const run = vi.fn().mockResolvedValue({});
    const bind = vi.fn().mockReturnValue({ run });
    const db = { prepare: vi.fn().mockReturnValue({ bind }) } as any;

    const token = await getValidAccessToken(user, env, db);
    expect(token).toBe('fresh-access-token');
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'));

    vi.unstubAllGlobals();
  });
});
