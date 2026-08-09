import { describe, it, expect, vi } from 'vitest';
import { getValidAccessToken } from '../../src/lib/tokens';
import { encrypt } from '../../src/lib/crypto';

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const env = {
  TOKEN_ENCRYPTION_KEY: KEY,
  SPOTIFY_CLIENT_ID: 'id',
  SPOTIFY_CLIENT_SECRET: 'secret',
} as any;

const user = { id: 'u1' } as any;

describe('getValidAccessToken', () => {
  it('returns the decrypted token directly when the stored token is not expired', async () => {
    const encAccess = await encrypt('valid-access-token', KEY);
    const encRefresh = await encrypt('refresh-token', KEY);
    const row = { access_token: encAccess, refresh_token: encRefresh, token_expires_at: Date.now() + 1000 * 60 * 60 };
    const first = vi.fn().mockResolvedValue(row);
    const run = vi.fn();
    const bind = vi.fn().mockReturnValue({ first, run });
    const db = { prepare: vi.fn().mockReturnValue({ bind }) } as any;

    const token = await getValidAccessToken(user, env, db);

    expect(token).toBe('valid-access-token');
    expect(run).not.toHaveBeenCalled(); // no refresh/update attempted
  });

  it('refreshes and persists new tokens into music_source_tokens when expired', async () => {
    const encAccess = await encrypt('stale-access-token', KEY);
    const encRefresh = await encrypt('refresh-token', KEY);
    const row = { access_token: encAccess, refresh_token: encRefresh, token_expires_at: Date.now() - 1000 };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access_token: 'fresh-access-token', refresh_token: 'refresh-token', expires_in: 3600 }),
          { status: 200 }
        )
      )
    );

    const first = vi.fn().mockResolvedValue(row);
    const run = vi.fn().mockResolvedValue({});
    const bind = vi.fn().mockReturnValue({ first, run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as any;

    const token = await getValidAccessToken(user, env, db);

    expect(token).toBe('fresh-access-token');
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE music_source_tokens'));

    vi.unstubAllGlobals();
  });

  it('persists the refreshed scope into granted_scope', async () => {
    const encAccess = await encrypt('stale-access-token', KEY);
    const encRefresh = await encrypt('refresh-token', KEY);
    const row = { access_token: encAccess, refresh_token: encRefresh, token_expires_at: Date.now() - 1000 };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access_token: 'fresh-access-token', refresh_token: 'refresh-token', expires_in: 3600, scope: 'streaming user-top-read' }),
          { status: 200 }
        )
      )
    );

    const first = vi.fn().mockResolvedValue(row);
    const run = vi.fn().mockResolvedValue({});
    const bind = vi.fn().mockReturnValue({ first, run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as any;

    await getValidAccessToken(user, env, db);

    expect(bind).toHaveBeenCalledWith(
      expect.anything(), // encrypted access token
      expect.anything(), // encrypted refresh token
      expect.anything(), // expiresAt
      'streaming user-top-read',
      expect.anything(), // updated_at
      user.id
    );

    vi.unstubAllGlobals();
  });

  it('throws a clear error when the user has no Spotify token row', async () => {
    const first = vi.fn().mockResolvedValue(null);
    const bind = vi.fn().mockReturnValue({ first });
    const db = { prepare: vi.fn().mockReturnValue({ bind }) } as any;

    await expect(getValidAccessToken(user, env, db)).rejects.toThrow();
  });
});
