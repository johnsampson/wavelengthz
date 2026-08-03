import { describe, it, expect, vi } from 'vitest';
import { sendEmail } from '../../src/lib/email';

const env = { RESEND_API_KEY: 'test-key', RESEND_FROM_ADDRESS: 'matches@wavelengthz.app' } as any;

describe('sendEmail', () => {
  it('posts to the Resend API with the expected shape', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendEmail(env, { to: 'user@example.com', subject: 'You matched!', html: '<p>hi</p>' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      })
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.to).toBe('user@example.com');
    expect(body.from).toBe('matches@wavelengthz.app');
    expect(body.subject).toBe('You matched!');

    vi.unstubAllGlobals();
  });

  it('throws when Resend returns a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));
    await expect(sendEmail(env, { to: 'a@b.com', subject: 's', html: 'h' })).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
