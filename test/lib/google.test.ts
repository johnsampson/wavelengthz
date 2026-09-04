import { describe, it, expect, vi } from 'vitest';
import { buildGoogleAuthUrl, exchangeGoogleCode, fetchGoogleProfile } from '../../src/lib/google';

const env = {
  GOOGLE_CLIENT_ID: 'client123',
  GOOGLE_CLIENT_SECRET: 'secret456',
  GOOGLE_REDIRECT_URI: 'http://localhost:8787/callback/google',
} as any;

describe('buildGoogleAuthUrl', () => {
  it('builds a Google authorize URL with client id, redirect uri, scope, and state', () => {
    const url = new URL(buildGoogleAuthUrl('state-abc', env));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/callback/google');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('scope')).toContain('openid');
    expect(url.searchParams.get('scope')).toContain('email');
    expect(url.searchParams.get('scope')).toContain('profile');
  });

  // Round 8 (issue #173): without this, Google silently reuses whatever
  // account is already active in the browser instead of offering a choice.
  it('forces the account picker with prompt=select_account, so a different Google account can be chosen', () => {
    const url = new URL(buildGoogleAuthUrl('state-abc', env));
    expect(url.searchParams.get('prompt')).toBe('select_account');
  });

  it('uses a supplied redirect_uri override instead of the env default', () => {
    const url = new URL(buildGoogleAuthUrl('state-abc', env, 'https://other.example.com/callback/google'));
    expect(url.searchParams.get('redirect_uri')).toBe('https://other.example.com/callback/google');
  });
});

describe('exchangeGoogleCode', () => {
  it('posts client_id, client_secret, code, and redirect_uri to the token endpoint', async () => {
    let sentBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        expect(input.toString()).toBe('https://oauth2.googleapis.com/token');
        sentBody = String(init?.body ?? '');
        return new Response(JSON.stringify({ access_token: 'gtoken', expires_in: 3600 }), { status: 200 });
      })
    );

    const result = await exchangeGoogleCode('auth-code', env);
    expect(result.access_token).toBe('gtoken');
    const params = new URLSearchParams(sentBody);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('auth-code');
    expect(params.get('redirect_uri')).toBe('http://localhost:8787/callback/google');
    expect(params.get('client_id')).toBe('client123');
    expect(params.get('client_secret')).toBe('secret456');

    vi.unstubAllGlobals();
  });

  it('throws with the response body on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid_grant', { status: 400 })));
    await expect(exchangeGoogleCode('bad-code', env)).rejects.toThrow(/400/);
    vi.unstubAllGlobals();
  });
});

describe('fetchGoogleProfile', () => {
  it('returns sub, email, email_verified, name, and picture from the userinfo response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        expect(input.toString()).toBe('https://openidconnect.googleapis.com/v1/userinfo');
        return new Response(
          JSON.stringify({ sub: 'google-123', email: 'a@b.com', email_verified: true, name: 'A B', picture: 'https://img.example/pic.jpg' }),
          { status: 200 }
        );
      })
    );

    const profile = await fetchGoogleProfile('gtoken');
    expect(profile.sub).toBe('google-123');
    expect(profile.email).toBe('a@b.com');
    expect(profile.email_verified).toBe(true);
    expect(profile.picture).toBe('https://img.example/pic.jpg');

    vi.unstubAllGlobals();
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    await expect(fetchGoogleProfile('bad-token')).rejects.toThrow(/401/);
    vi.unstubAllGlobals();
  });
});
