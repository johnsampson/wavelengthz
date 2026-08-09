import { describe, it, expect, vi } from 'vitest';
import { encryptPayload, buildVapidAuthHeader, sendWebPush } from '../../src/lib/webPush';

function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importEcKeyPairFromRaw(publicRaw: Uint8Array, privateRaw: Uint8Array): Promise<CryptoKeyPair> {
  const publicKey = await crypto.subtle.importKey('raw', publicRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const x = publicRaw.slice(1, 33);
  const y = publicRaw.slice(33, 65);
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64urlEncode(x), y: b64urlEncode(y), d: b64urlEncode(privateRaw), ext: true };
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { publicKey, privateKey };
}

// RFC 8291 Appendix A's published test vector -- verified byte-for-byte
// against the RFC's own text during planning. encryptPayload's optional
// `overrides` (salt + ephemeral keypair) exist purely so this test can pin
// the two normally-random inputs and assert an exact match; production
// leaves them unset and gets fresh random values every send.
describe('encryptPayload', () => {
  it('matches RFC 8291 Appendix A byte-for-byte', async () => {
    const uaPublicRaw = b64urlDecode('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
    const asPublicRaw = b64urlDecode('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    const asPrivateRaw = b64urlDecode('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw');
    const authSecret = 'BTBZMqHH6r4Tts7J_aSIgg';
    const p256dh = b64urlEncode(uaPublicRaw);
    const salt = b64urlDecode('DGv6ra1nlYgDCS1FRnbzlw');
    const ephemeralKeyPair = await importEcKeyPairFromRaw(asPublicRaw, asPrivateRaw);
    const plaintext = new TextEncoder().encode('When I grow up, I want to be a watermelon');

    const result = await encryptPayload(plaintext, p256dh, authSecret, { salt, ephemeralKeyPair });

    const expected = b64urlDecode(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
    );
    expect(b64urlEncode(result)).toBe(b64urlEncode(expected));
  });
});

describe('buildVapidAuthHeader', () => {
  const env = { VAPID_PUBLIC_KEY: 'BC-IIfT4yho1Lp9x06rIRv0bo-Ns2hq77fpxI61ELRF2DQm0TxTLnyzHcWd2QRB6vJyJIN1gGG8In355vJGGF5E', VAPID_PRIVATE_KEY: 'myv3AP-P0PyJxUMi2NBShq7cAodxuEcOg1iuAYO5Q2I', VAPID_SUBJECT: 'mailto:test@example.com' } as any;

  it('produces a "vapid t=..., k=..." header whose JWT verifies against the public key', async () => {
    const header = await buildVapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc123', env);
    expect(header).toMatch(/^vapid t=([^,]+), k=(.+)$/);
    const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(k).toBe(env.VAPID_PUBLIC_KEY);

    const [headerB64, claimsB64, sigB64] = jwt.split('.');
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(claimsB64)));
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:test@example.com');

    const publicKey = await crypto.subtle.importKey('raw', b64urlDecode(env.VAPID_PUBLIC_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      b64urlDecode(sigB64),
      new TextEncoder().encode(`${headerB64}.${claimsB64}`)
    );
    expect(valid).toBe(true);
  });
});

describe('sendWebPush', () => {
  const env = { VAPID_PUBLIC_KEY: 'BC-IIfT4yho1Lp9x06rIRv0bo-Ns2hq77fpxI61ELRF2DQm0TxTLnyzHcWd2QRB6vJyJIN1gGG8In355vJGGF5E', VAPID_PRIVATE_KEY: 'myv3AP-P0PyJxUMi2NBShq7cAodxuEcOg1iuAYO5Q2I', VAPID_SUBJECT: 'mailto:test@example.com' } as any;
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  };

  it('POSTs the encrypted payload with the right headers and reports ok:true on a 2xx response', async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(subscription.endpoint);
      capturedInit = init;
      return new Response('', { status: 201 });
    }));

    const result = await sendWebPush(subscription, { title: 't', body: 'b', url: '/matches' }, env);
    expect(result).toEqual({ ok: true });
    expect(capturedInit!.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' });
    expect((capturedInit!.headers as Record<string, string>).Authorization).toMatch(/^vapid t=/);

    vi.unstubAllGlobals();
  });

  it('reports expired:true on a 410, expired:false on a 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 410 })));
    expect(await sendWebPush(subscription, { title: 't', body: 'b', url: '/matches' }, env)).toEqual({ ok: false, expired: true });
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    expect(await sendWebPush(subscription, { title: 't', body: 'b', url: '/matches' }, env)).toEqual({ ok: false, expired: false });
    vi.unstubAllGlobals();
  });
});
