// RFC 8291 (message encryption) + RFC 8292 (VAPID) implemented directly
// against Workers' native crypto.subtle -- no new dependency. Verified
// byte-for-byte against RFC 8291 Appendix A's published test vector; see
// test/lib/webPush.test.ts.

function base64UrlToBytes(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, lengthBytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, lengthBytes * 8);
  return new Uint8Array(bits);
}

/**
 * Encrypts a push message payload per RFC 8291 ("aes128gcm" content coding,
 * RFC 8188). `overrides` exists only for test determinism (a fixed salt and
 * ephemeral ECDH keypair instead of fresh random ones) -- production always
 * leaves it unset.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  authSecret: string,
  overrides?: { salt?: Uint8Array; ephemeralKeyPair?: CryptoKeyPair }
): Promise<Uint8Array> {
  const uaPublicRaw = base64UrlToBytes(p256dh);
  const auth = base64UrlToBytes(authSecret);

  const asKeyPair = (overrides?.ephemeralKeyPair ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']))) as CryptoKeyPair;
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey) as ArrayBuffer);
  const uaPublicKey = await crypto.subtle.importKey('raw', uaPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey } as any, asKeyPair.privateKey, 256));

  const keyInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(auth, ecdhSecret, keyInfo, 32);

  const salt = overrides?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const paddedPlaintext = concatBytes(plaintext, new Uint8Array([0x02]));
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, paddedPlaintext));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  const header = concatBytes(salt, recordSize, new Uint8Array([asPublicRaw.length]), asPublicRaw);

  return concatBytes(header, ciphertext);
}

async function importVapidPrivateKey(env: Env): Promise<CryptoKey> {
  const publicRaw = base64UrlToBytes(env.VAPID_PUBLIC_KEY);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(publicRaw.slice(1, 33)),
    y: bytesToBase64Url(publicRaw.slice(33, 65)),
    d: env.VAPID_PRIVATE_KEY,
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Builds the `Authorization: vapid t=<jwt>, k=<publicKey>` header value per RFC 8292. */
export async function buildVapidAuthHeader(endpoint: string, env: Env): Promise<string> {
  const audience = new URL(endpoint).origin;
  const encoder = new TextEncoder();
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToBase64Url(
    encoder.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: env.VAPID_SUBJECT }))
  );
  const unsigned = `${header}.${claims}`;
  const privateKey = await importVapidPrivateKey(env);
  // WebCrypto's ECDSA sign() output is the raw r||s concatenation (64 bytes
  // for P-256), which is exactly what a JWS ES256 signature is -- no DER
  // reformatting needed.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, encoder.encode(unsigned)));
  return `vapid t=${unsigned}.${bytesToBase64Url(signature)}, k=${env.VAPID_PUBLIC_KEY}`;
}

export type SendWebPushResult = { ok: true } | { ok: false; expired: boolean };

export async function sendWebPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: { title: string; body: string; url: string },
  env: Env
): Promise<SendWebPushResult> {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const [encryptedBody, authorization] = await Promise.all([
    encryptPayload(plaintext, subscription.p256dh, subscription.auth),
    buildVapidAuthHeader(subscription.endpoint, env),
  ]);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: '86400', Authorization: authorization },
    body: encryptedBody,
  });

  if (res.ok) return { ok: true };
  return { ok: false, expired: res.status === 404 || res.status === 410 };
}
