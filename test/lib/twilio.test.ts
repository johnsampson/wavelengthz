import { describe, it, expect, vi } from 'vitest';
import { lookupPhoneNumber, startVerification, checkVerification, isBlockedLineType } from '../../src/lib/twilio';

const env = {
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'secret',
  TWILIO_VERIFY_SERVICE_SID: 'VA123',
} as any;

describe('lookupPhoneNumber', () => {
  it('parses valid + line type from a successful Lookup response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ valid: true, phone_number: '+15108675310', line_type_intelligence: { type: 'mobile' } }),
          { status: 200 }
        )
      )
    );
    const result = await lookupPhoneNumber('+15108675310', env);
    expect(result).toEqual({ valid: true, phoneNumber: '+15108675310', lineType: 'mobile' });
    vi.unstubAllGlobals();
  });

  it('sends Basic Auth built from the account sid and auth token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ valid: true, phone_number: '+1', line_type_intelligence: null }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await lookupPhoneNumber('+15108675310', env);
    const init = fetchMock.mock.calls[0]![1]!;
    expect((init.headers as any).Authorization).toBe(`Basic ${btoa('AC123:secret')}`);
    vi.unstubAllGlobals();
  });

  it('handles a response with no line_type_intelligence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ valid: false, phone_number: '+1555', line_type_intelligence: null }), { status: 200 }))
    );
    const result = await lookupPhoneNumber('+1555', env);
    expect(result.lineType).toBeNull();
    vi.unstubAllGlobals();
  });

  it('throws on a Twilio error response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));
    await expect(lookupPhoneNumber('not-a-number', env)).rejects.toThrow(/Twilio lookup failed/);
    vi.unstubAllGlobals();
  });
});

describe('startVerification', () => {
  it('resolves on a successful start', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'pending' }), { status: 201 })));
    await expect(startVerification('+15108675310', env)).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('throws when Twilio rejects the number', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 60200, message: 'Invalid parameter' }), { status: 400 })));
    await expect(startVerification('garbage', env)).rejects.toThrow(/Twilio verification start failed/);
    vi.unstubAllGlobals();
  });
});

describe('checkVerification', () => {
  it('reports approved on a matching code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'approved', valid: true }), { status: 200 })));
    const result = await checkVerification('+15108675310', '123456', env);
    expect(result).toEqual({ approved: true });
    vi.unstubAllGlobals();
  });

  it('reports not approved on a wrong code (still a 200 from Twilio)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'pending', valid: false }), { status: 200 })));
    const result = await checkVerification('+15108675310', '000000', env);
    expect(result).toEqual({ approved: false });
    vi.unstubAllGlobals();
  });

  it('reports not approved (not a thrown error) when Twilio 404s an expired/exhausted verification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 20404 }), { status: 404 })));
    const result = await checkVerification('+15108675310', '123456', env);
    expect(result).toEqual({ approved: false });
    vi.unstubAllGlobals();
  });

  it('throws on a genuine server/auth error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    await expect(checkVerification('+15108675310', '123456', env)).rejects.toThrow(/Twilio verification check failed/);
    vi.unstubAllGlobals();
  });
});

describe('isBlockedLineType', () => {
  it('blocks voip', () => {
    expect(isBlockedLineType('voip')).toBe(true);
  });

  it('allows mobile and landline', () => {
    expect(isBlockedLineType('mobile')).toBe(false);
    expect(isBlockedLineType('landline')).toBe(false);
  });

  it('allows an unknown/null line type -- Twilio couldn\'t determine it, that\'s not the same as it being VOIP', () => {
    expect(isBlockedLineType(null)).toBe(false);
  });
});
