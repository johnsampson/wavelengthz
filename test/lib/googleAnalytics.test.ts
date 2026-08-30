import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendToGA4 } from '../../src/lib/googleAnalytics';

afterEach(() => {
  vi.unstubAllGlobals();
});

const envWithGA4 = { GA4_MEASUREMENT_ID: 'G-TEST123', GA4_API_SECRET: 'secret123' } as any;

describe('sendToGA4', () => {
  it('does nothing, without calling fetch, when GA4_MEASUREMENT_ID is unset', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await sendToGA4({ GA4_API_SECRET: 'secret123' } as any, { clientId: 'c1', eventName: 'session_start' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing, without calling fetch, when GA4_API_SECRET is unset', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await sendToGA4({ GA4_MEASUREMENT_ID: 'G-TEST123' } as any, { clientId: 'c1', eventName: 'session_start' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to the Measurement Protocol endpoint with the measurement id and api secret in the query string', async () => {
    const fetchMock = vi.fn(async (url: string, options?: any) => new Response('', { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendToGA4(envWithGA4, { clientId: 'c1', eventName: 'session_start' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.google-analytics.com/mp/collect?measurement_id=G-TEST123&api_secret=secret123');
  });

  it('sends client_id and the event name/params in the request body', async () => {
    const fetchMock = vi.fn(async (url: string, options?: any) => new Response('', { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendToGA4(envWithGA4, { clientId: 'c1', eventName: 'song_play', params: { spotifyId: 'sp1' } });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse((options as any).body);
    expect(body.client_id).toBe('c1');
    expect(body.events).toEqual([{ name: 'song_play', params: { spotifyId: 'sp1' } }]);
  });

  it('omits user_id entirely for an anonymous event, rather than sending null', async () => {
    const fetchMock = vi.fn(async (url: string, options?: any) => new Response('', { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendToGA4(envWithGA4, { clientId: 'c1', userId: null, eventName: 'session_start' });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse((options as any).body);
    expect(body).not.toHaveProperty('user_id');
  });

  it('includes user_id when a real user is signed in', async () => {
    const fetchMock = vi.fn(async (url: string, options?: any) => new Response('', { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendToGA4(envWithGA4, { clientId: 'c1', userId: 'u1', eventName: 'session_start' });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse((options as any).body);
    expect(body.user_id).toBe('u1');
  });

  it('adds session_id and engagement_time_msec to params when a sessionId is given', async () => {
    const fetchMock = vi.fn(async (url: string, options?: any) => new Response('', { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendToGA4(envWithGA4, { clientId: 'c1', sessionId: 's1', eventName: 'session_start' });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse((options as any).body);
    expect(body.events[0].params).toEqual({ session_id: 's1', engagement_time_msec: 1 });
  });

  it('never throws when the GA4 request itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );

    await expect(sendToGA4(envWithGA4, { clientId: 'c1', eventName: 'session_start' })).resolves.toBeUndefined();
  });
});
