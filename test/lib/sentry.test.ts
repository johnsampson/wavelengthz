import { describe, it, expect, vi } from 'vitest';
import { reportError } from '../../src/lib/sentry';

describe('reportError', () => {
  it('posts to the Sentry envelope endpoint derived from the DSN', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const env = { SENTRY_DSN: 'https://publickey@o123.ingest.sentry.io/456' } as any;
    await reportError(env, new Error('boom'), { path: '/api/me' });

    expect(fetchMock).toHaveBeenCalled();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('o123.ingest.sentry.io');
    expect(url).toContain('/api/456/envelope/');

    vi.unstubAllGlobals();
  });

  it('never throws even when Sentry itself is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const env = { SENTRY_DSN: 'https://publickey@o123.ingest.sentry.io/456' } as any;
    await expect(reportError(env, new Error('boom'), { path: '/x' })).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('is a no-op when SENTRY_DSN is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await reportError({} as any, new Error('boom'), { path: '/x' });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
