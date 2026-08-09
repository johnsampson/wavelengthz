# Web Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push notifications for new matches and new 1:1 messages, on iOS and Android, via the standard Web Push API against the existing PWA — no native app, no App/Play Store, no Apple Developer Program, no DUNS.

**Architecture:** A new `src/lib/webPush.ts` implements RFC 8291 message encryption and RFC 8292 VAPID JWT signing directly against Workers' native `crypto.subtle` (no new npm dependency). A new `push_subscriptions` table stores one row per browser/device. `notifyMatch`/`notifyMessage` (`src/lib/notifications.ts`) gain a push send alongside their existing email send, at the same trigger points. The frontend gets a Settings toggle (the only path to `Notification.requestPermission()` — nothing automatic) and an iOS-only "Add to Home Screen" banner, since iOS blocks push permission entirely outside an installed PWA.

**Tech Stack:** TypeScript, Cloudflare Workers (`crypto.subtle`, no new dependency), D1, itty-router, Alpine.js, Vitest + `@cloudflare/vitest-pool-workers`.

## Global Constraints

- No new npm dependency for push — RFC 8291/8292 are implemented directly against Web Crypto.
- Nothing requests notification permission automatically; the Settings toggle is the only trigger, since browsers give exactly one shot at the permission prompt per origin.
- Group chat is out of scope — only 1:1 matches and messages push, matching the existing email notification scope.
- A push send that 404/410s means the subscription is gone; delete that row. A failure on one of a user's subscriptions must not block sending to their other devices (same per-item isolation this codebase already uses in `purgeExpiredDeletions` and `sendDelayedMatchNotificationEmails`).
- Full suite (`npx vitest run`) and `npx tsc --noEmit` clean is the acceptance bar for every task.

---

### Task 1: `src/lib/webPush.ts` + VAPID config

**Files:**
- Create: `src/lib/webPush.ts`
- Create: `test/lib/webPush.test.ts`
- Modify: `src/env.d.ts`
- Modify: `wrangler.toml`

**Interfaces:**
- Produces: `sendWebPush(subscription: {endpoint: string; p256dh: string; auth: string}, payload: {title: string; body: string; url: string}, env: Env): Promise<{ok: true} | {ok: false; expired: boolean}>`, `encryptPayload(plaintext: Uint8Array, p256dh: string, authSecret: string, overrides?: {salt?: Uint8Array; ephemeralKeyPair?: CryptoKeyPair}): Promise<Uint8Array>`, `buildVapidAuthHeader(endpoint: string, env: Env): Promise<string>` from `src/lib/webPush.ts`.
- Produces: `env.VAPID_PRIVATE_KEY: string`, `env.VAPID_SUBJECT: string` (secrets), `env.VAPID_PUBLIC_KEY: string` (plain var).

- [ ] **Step 1: Generate a real VAPID keypair for local dev/test use**

Run this once (Node, not part of the app) to produce the values used below and in your own `.dev.vars`:

```bash
node -e "
const { webcrypto: crypto } = require('node:crypto');
(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  console.log('VAPID_PUBLIC_KEY=' + pub);
  console.log('VAPID_PRIVATE_KEY=' + jwk.d);
})();
"
```

- [ ] **Step 2: Add `VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` to `src/env.d.ts`**

Add to the `Env` interface (same treatment as `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`):

```typescript
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
```

- [ ] **Step 3: Add `VAPID_PUBLIC_KEY` to `wrangler.toml`**

In the top-level `[vars]` block, using the `VAPID_PUBLIC_KEY` value from Step 1:

```toml
# The frontend fetches this via GET /api/push/vapid-public-key to pass as
# pushManager.subscribe()'s applicationServerKey -- it's not secret, the
# browser receives it directly. VAPID_PRIVATE_KEY/VAPID_SUBJECT (the matching
# private scalar + contact mailto: RFC 8292 requires) are secrets, set via
# `wrangler secret put`, never committed.
VAPID_PUBLIC_KEY = "<your generated public key>"
```

In the `[env.test.vars]` block, add:

```toml
VAPID_PUBLIC_KEY = "BC-IIfT4yho1Lp9x06rIRv0bo-Ns2hq77fpxI61ELRF2DQm0TxTLnyzHcWd2QRB6vJyJIN1gGG8In355vJGGF5E"
VAPID_PRIVATE_KEY = "myv3AP-P0PyJxUMi2NBShq7cAodxuEcOg1iuAYO5Q2I"
VAPID_SUBJECT = "mailto:test@example.com"
```

Run `npx wrangler types` afterward so the generated `Env`/`Cloudflare.Env` interfaces include `VAPID_PUBLIC_KEY`.

- [ ] **Step 4: Write the failing tests**

```typescript
// test/lib/webPush.test.ts
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
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run test/lib/webPush.test.ts`
Expected: FAIL — `src/lib/webPush.ts` does not exist.

- [ ] **Step 6: Write `src/lib/webPush.ts`**

```typescript
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

  const asKeyPair = overrides?.ephemeralKeyPair ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));
  const uaPublicKey = await crypto.subtle.importKey('raw', uaPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, asKeyPair.privateKey, 256));

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
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/lib/webPush.test.ts`
Expected: PASS (4/4)

- [ ] **Step 8: Commit**

```bash
git add src/lib/webPush.ts test/lib/webPush.test.ts src/env.d.ts wrangler.toml worker-configuration.d.ts
git commit -m "feat: add Web Push send (RFC 8291 encryption + RFC 8292 VAPID)"
```

---

### Task 2: `push_subscriptions` table + wire push into `notifyMatch`/`notifyMessage`

**Files:**
- Create: `migrations/0009_add_push_subscriptions.sql`
- Modify: `src/lib/notifications.ts`
- Modify: `test/lib/notifications.test.ts`

**Interfaces:**
- Consumes: `sendWebPush` (Task 1).
- Produces: `sendPushToUser(db: D1Database, env: Env, userId: string, payload: {title: string; body: string; url: string}): Promise<boolean>` from `src/lib/notifications.ts` — `true` iff at least one subscription existed for that user (attempted, not necessarily delivered — matches `sendEmail`'s existing "attempted" semantics).
- `notifyMatch`/`notifyMessage` now push to every subscription for the recipient, alongside the existing email. `email_sent_at` is set whenever *either* channel was used (was email-only before).

- [ ] **Step 1: Create the migration**

```bash
npx wrangler d1 migrations create wavelengthz-db add_push_subscriptions
```

This creates `0009_add_push_subscriptions.sql` with a real, auto-generated `-- Migration number: 0009 <timestamp>` header — leave that line as generated. Append below it:

```sql
-- One row per browser/device push subscription. `endpoint UNIQUE` is the
-- natural dedupe key -- subscribing again with the same endpoint (e.g. the
-- Settings toggle re-enabled) is an upsert, not a new row. A 404/410 from
-- the push service means the subscription is gone; src/lib/notifications.ts
-- deletes that row rather than retrying it forever.
CREATE TABLE push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
```

- [ ] **Step 2: Apply it locally**

```bash
npx wrangler d1 migrations apply wavelengthz-db --local
```

- [ ] **Step 3: Update `test/lib/notifications.test.ts`'s `beforeEach` cleanup**

`push_subscriptions` FK-references `users`, so it must be deleted before them. Change:

```typescript
  await env.DB.exec('DELETE FROM messages; DELETE FROM notifications; DELETE FROM matches; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
```

to:

```typescript
  await env.DB.exec('DELETE FROM messages; DELETE FROM notifications; DELETE FROM push_subscriptions; DELETE FROM matches; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
```

- [ ] **Step 4: Write the failing tests**

Add near the top of `test/lib/notifications.test.ts`, after the existing imports:

```typescript
async function insertPushSubscription(db: D1Database, userId: string, endpoint: string) {
  await db
    .prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), userId, endpoint, 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', Date.now())
    .run();
}

const VAPID_TEST_ENV = { VAPID_PUBLIC_KEY: 'BC-IIfT4yho1Lp9x06rIRv0bo-Ns2hq77fpxI61ELRF2DQm0TxTLnyzHcWd2QRB6vJyJIN1gGG8In355vJGGF5E', VAPID_PRIVATE_KEY: 'myv3AP-P0PyJxUMi2NBShq7cAodxuEcOg1iuAYO5Q2I', VAPID_SUBJECT: 'mailto:test@example.com' };
```

Append to the `describe('notifyMatch', ...)` block:

```typescript
  it('pushes to a recipient with no email on file and marks the notification processed', async () => {
    await insertPushSubscription(env.DB, 'u2', 'https://push.example/u2-device');
    const fetchMock = vi.fn(async (url: string) => new Response('', { status: url.includes('push.example') ? 201 : 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMatch(env.DB, { ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'm1');

    expect(fetchMock).toHaveBeenCalledWith('https://push.example/u2-device', expect.anything());
    const n2 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n2').first<any>();
    expect(n2.email_sent_at).not.toBeNull(); // processed via push even with no email

    vi.unstubAllGlobals();
  });

  it('deletes an expired (410) subscription but keeps sending to the recipient\'s other devices', async () => {
    await insertPushSubscription(env.DB, 'u2', 'https://push.example/u2-dead');
    await insertPushSubscription(env.DB, 'u2', 'https://push.example/u2-alive');
    const fetchMock = vi.fn(async (url: string) => new Response('', { status: url.includes('u2-dead') ? 410 : 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMatch(env.DB, { ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'm1');

    const remaining = await env.DB.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?').bind('u2').all<any>();
    expect(remaining.results.map((r: any) => r.endpoint)).toEqual(['https://push.example/u2-alive']);

    vi.unstubAllGlobals();
  });
```

Append to the `describe('notifyMessage', ...)` block:

```typescript
  it('pushes to the recipient even when they have no email on file', async () => {
    await env.DB.prepare(`UPDATE users SET email = NULL WHERE id = 'u1'`).run();
    await insertPushSubscription(env.DB, 'u1', 'https://push.example/u1-device');
    await env.DB.prepare(`INSERT INTO messages (id, match_id, sender_id, body, created_at) VALUES ('msg1', 'm1', 'u2', 'hi', 1000)`).run();
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n3', 'u1', 'message', 'msg1', 1000)`
    ).run();
    const fetchMock = vi.fn(async () => new Response('', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyMessage(env.DB, { ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, 'msg1', 'u1');

    expect(fetchMock).toHaveBeenCalledWith('https://push.example/u1-device', expect.anything());
    const n3 = await env.DB.prepare('SELECT email_sent_at FROM notifications WHERE id = ?').bind('n3').first<any>();
    expect(n3.email_sent_at).not.toBeNull();

    vi.unstubAllGlobals();
  });
```

Append a new test to the `describe('sendDelayedMatchNotificationEmails', ...)` block:

```typescript
  it('surfaces a match whose only email-eligible-or-push-eligible recipient has push but no email', async () => {
    await env.DB.exec(`DELETE FROM notifications; DELETE FROM push_subscriptions;`);
    await env.DB.prepare(`UPDATE users SET email = NULL WHERE id IN ('u1', 'u2')`).run();
    await insertPushSubscription(env.DB, 'u2', 'https://push.example/u2-device');
    await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, related_id, created_at) VALUES ('n-push-only', 'u2', 'match', 'm1', 1000)`).run();

    const fetchMock = vi.fn(async () => new Response('', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDelayedMatchNotificationEmails({ DB: env.DB, ...VAPID_TEST_ENV, RESEND_API_KEY: 'k', RESEND_FROM_ADDRESS: 'f@x.com' } as any, AFTER_DELAY);

    expect(fetchMock).toHaveBeenCalledWith('https://push.example/u2-device', expect.anything());

    vi.unstubAllGlobals();
  });
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run test/lib/notifications.test.ts`
Expected: FAIL — no push sending exists yet.

- [ ] **Step 6: Update `src/lib/notifications.ts`**

Add the import at the top:

```typescript
import { sendWebPush } from './webPush';
```

Add this function (placed after `getMatchNotificationDelayMs`, before `notifyMatch`):

```typescript
/**
 * Sends a push notification to every subscription on file for a user.
 * Returns true iff at least one subscription existed and was attempted --
 * "attempted", not "confirmed delivered", matching sendEmail's existing
 * semantics (a successful HTTP response isn't proof of a human reading it).
 * A per-subscription failure is isolated (logged, not thrown) so one dead
 * device never blocks sending to the user's other devices -- same reasoning
 * as this file's other per-recipient isolation below.
 */
export async function sendPushToUser(
  db: D1Database,
  env: Env,
  userId: string,
  payload: { title: string; body: string; url: string }
): Promise<boolean> {
  const subs = await db
    .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .bind(userId)
    .all<{ id: string; endpoint: string; p256dh: string; auth: string }>();

  if (subs.results.length === 0) return false;

  for (const sub of subs.results) {
    try {
      const result = await sendWebPush({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload, env);
      if (!result.ok && result.expired) {
        await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
      }
    } catch (err) {
      console.error(`Push send failed for subscription ${sub.id}:`, err);
    }
  }
  return true;
}
```

Replace `notifyMatch`'s body:

```typescript
export async function notifyMatch(db: D1Database, env: Env, matchId: string): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT n.id as notification_id, n.user_id, u.email FROM notifications n
       JOIN users u ON u.id = n.user_id
       WHERE n.related_id = ? AND n.type = 'match' AND u.deleted_at IS NULL AND n.email_sent_at IS NULL`
    )
    .bind(matchId)
    .all<{ notification_id: string; user_id: string; email: string | null }>();

  for (const row of rows.results) {
    const pushed = await sendPushToUser(db, env, row.user_id, {
      title: "You've got a new match!",
      body: 'Open the app to say hi.',
      url: '/matches',
    });

    if (row.email) {
      await sendEmail(env, {
        to: row.email,
        subject: "You've got a new match!",
        html: `<p>You matched with someone on Wavelengthz. Open the app to say hi.</p>`,
      });
    }

    // email_sent_at now doubles as "fully processed for outbound
    // notification" rather than "email specifically sent" -- set whenever
    // either channel was used, so a push-only (no email on file) recipient
    // isn't reprocessed by every future cron sweep the way it would be if
    // this stayed keyed to email alone.
    if (row.email || pushed) {
      await db.prepare('UPDATE notifications SET email_sent_at = ? WHERE id = ?').bind(Date.now(), row.notification_id).run();
    }
  }
}
```

Replace `notifyMessage`'s body:

```typescript
export async function notifyMessage(db: D1Database, env: Env, messageId: string, recipientId: string): Promise<void> {
  // Never notify (any channel) an account inside its post-deletion grace
  // period. Unlike before push existed, a missing email no longer
  // short-circuits this early -- a push-only recipient still needs the
  // notification-row check below and a push attempt.
  const recipient = await db
    .prepare('SELECT email FROM users WHERE id = ? AND deleted_at IS NULL')
    .bind(recipientId)
    .first<{ email: string | null }>();
  if (!recipient) return;

  const notification = await db
    .prepare(`SELECT id FROM notifications WHERE related_id = ? AND type = 'message' AND user_id = ?`)
    .bind(messageId, recipientId)
    .first<{ id: string }>();
  if (!notification) return;

  const pushed = await sendPushToUser(db, env, recipientId, {
    title: 'New message on Wavelengthz',
    body: 'Open the app to read it.',
    url: '/messages',
  });

  if (recipient.email) {
    await sendEmail(env, {
      to: recipient.email,
      subject: 'New message on Wavelengthz',
      html: `<p>You have a new message. Open the app to read it.</p>`,
    });
  }

  if (recipient.email || pushed) {
    await db.prepare('UPDATE notifications SET email_sent_at = ? WHERE id = ?').bind(Date.now(), notification.id).run();
  }
}
```

Replace `sendDelayedMatchNotificationEmails`'s query (the `rows` selection at the top of the function):

```typescript
  // Broadened beyond "has an email" now that push exists: a match where a
  // recipient has no email on file but does have a push subscription must
  // still surface here, or notifyMatch never runs for that match at all and
  // that recipient's push silently never fires.
  const rows = await db
    .prepare(
      `SELECT DISTINCT n.related_id as match_id FROM notifications n
       JOIN users u ON u.id = n.user_id
       WHERE n.type = 'match' AND n.email_sent_at IS NULL AND n.created_at <= ?
         AND (u.email IS NOT NULL OR EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id))`
    )
    .bind(cutoff)
    .all<{ match_id: string }>();
```

(The rest of `sendDelayedMatchNotificationEmails` — the per-match `unmatched_at` check and the `notifyMatch` call — is unchanged.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/lib/notifications.test.ts`
Expected: PASS (all cases green, including every pre-existing test unaffected)

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run`
Expected: all files pass — `test/routes/matches.test.ts` and anything else touching `notifyMatch`/`notifyMessage` indirectly must still be green, since no exported signature changed.

- [ ] **Step 9: Commit**

```bash
git add migrations/0009_add_push_subscriptions.sql src/lib/notifications.ts test/lib/notifications.test.ts
git commit -m "feat: push matches and messages alongside existing email notifications"
```

---

### Task 3: `/api/push/*` routes

**Files:**
- Create: `src/routes/push.ts`
- Create: `test/routes/push.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks (reads `env.VAPID_PUBLIC_KEY` directly; writes to `push_subscriptions` directly).
- Produces: `GET /api/push/vapid-public-key` (unauthenticated), `POST /api/push/subscribe`, `POST /api/push/unsubscribe` (both auth-gated).

- [ ] **Step 1: Write the failing tests**

```typescript
// test/routes/push.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema } from '../apply-schema';
import { createSession } from '../../src/lib/session';
import { insertTestUser } from '../helpers/createUser';
import worker from '../../src/index';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function cookieFor(userId: string) {
  const { cookie } = await createSession(env.DB, userId);
  return `wl_session=${cookie.split(';')[0].split('=')[1]}`;
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM push_subscriptions; DELETE FROM sessions; DELETE FROM music_source_tokens; DELETE FROM auth_identities; DELETE FROM users;');
  await insertTestUser(env.DB, { id: 'u1', spotifyId: 'sp1' });
  await insertTestUser(env.DB, { id: 'u2', spotifyId: 'sp2' });
});

describe('GET /api/push/vapid-public-key', () => {
  it('returns the public key with no auth required', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/push/vapid-public-key'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.publicKey).toBe(env.VAPID_PUBLIC_KEY);
  });
});

describe('POST /api/push/subscribe', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }) }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it('inserts a subscription for the current user', async () => {
    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/push/subscribe', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').bind('https://push.example/x').first<any>();
    expect(row.user_id).toBe('u1');
    expect(row.p256dh).toBe('p');
    expect(row.auth).toBe('a');
  });

  it('upserts by endpoint instead of creating a duplicate row', async () => {
    const cookie = await cookieFor('u1');
    const subscribe = () =>
      worker.fetch(
        new Request('http://localhost/api/push/subscribe', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: 'https://push.example/x', keys: { p256dh: 'p2', auth: 'a2' } }),
        }),
        env,
        {} as ExecutionContext
      );
    await subscribe();
    await subscribe();
    const rows = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').bind('https://push.example/x').all<any>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0].p256dh).toBe('p2');
  });
});

describe('POST /api/push/unsubscribe', () => {
  it('returns 401 when not logged in', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: 'https://push.example/x' }) }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(401);
  });

  it('deletes only the current user\'s matching subscription', async () => {
    await env.DB.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('s1', 'u1', 'https://push.example/x', 'p', 'a', ?)`).bind(Date.now()).run();
    await env.DB.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('s2', 'u2', 'https://push.example/y', 'p', 'a', ?)`).bind(Date.now()).run();

    const cookie = await cookieFor('u1');
    const res = await worker.fetch(
      new Request('http://localhost/api/push/unsubscribe', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://push.example/x' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(res.status).toBe(200);
    expect(await env.DB.prepare('SELECT * FROM push_subscriptions WHERE id = ?').bind('s1').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM push_subscriptions WHERE id = ?').bind('s2').first()).not.toBeNull();
  });

  it('does not delete another user\'s subscription at the same endpoint mismatch attempt', async () => {
    await env.DB.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('s2', 'u2', 'https://push.example/y', 'p', 'a', ?)`).bind(Date.now()).run();

    const cookie = await cookieFor('u1');
    await worker.fetch(
      new Request('http://localhost/api/push/unsubscribe', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://push.example/y' }),
      }),
      env,
      {} as ExecutionContext
    );
    expect(await env.DB.prepare('SELECT * FROM push_subscriptions WHERE id = ?').bind('s2').first()).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/push.test.ts`
Expected: FAIL — 404s, no such routes yet.

- [ ] **Step 3: Write `src/routes/push.ts`**

```typescript
import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';

export function registerPushRoutes(router: RouterType) {
  router.get('/api/push/vapid-public-key', async (_request: Request, env: Env) => {
    return Response.json({ publicKey: env.VAPID_PUBLIC_KEY });
  });

  router.post('/api/push/subscribe', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { endpoint, keys } = await request.json<{ endpoint: string; keys: { p256dh: string; auth: string } }>();

    await env.DB.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
    ).bind(crypto.randomUUID(), user.id, endpoint, keys.p256dh, keys.auth, Date.now()).run();

    return Response.json({ ok: true });
  });

  router.post('/api/push/unsubscribe', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { endpoint } = await request.json<{ endpoint: string }>();
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(endpoint, user.id).run();

    return Response.json({ ok: true });
  });
}
```

- [ ] **Step 4: Register the routes in `src/index.ts`**

Add the import alongside the other `register*Routes` imports:

```typescript
import { registerPushRoutes } from './routes/push';
```

Add the call alongside the other `register*Routes(router)` calls (order doesn't matter — itty-router matches by path):

```typescript
registerPushRoutes(router);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/routes/push.test.ts`
Expected: PASS (7/7)

- [ ] **Step 6: Run the full suite and type-check**

Run: `npx vitest run` and `npx tsc --noEmit`
Expected: all green, zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/routes/push.ts test/routes/push.test.ts src/index.ts
git commit -m "feat: add /api/push/vapid-public-key, /subscribe, /unsubscribe routes"
```

---

### Task 4: `public/sw.js` push handling

**Files:**
- Modify: `public/sw.js`

**Interfaces:**
- Consumes: nothing from earlier tasks directly — this is the browser-side receiver for whatever `sendWebPush` (Task 1) sends, matching the `{title, body, url}` JSON shape `sendPushToUser` encrypts.

No existing test file covers `sw.js` (its `install`/`activate`/`fetch` handlers are untested today too) — this stays consistent with that, verified manually per Step 3 below rather than via Vitest.

- [ ] **Step 1: Bump the cache version and add the changelog line**

At the top of `public/sw.js`, change:

```javascript
const CACHE_NAME = 'wavelengthz-shell-v19';
```

to:

```javascript
const CACHE_NAME = 'wavelengthz-shell-v20';
```

Add to the end of the versioned comment block above it: `v20 adds push notification handling (push + notificationclick listeners) -- see docs/superpowers/plans/2026-08-09-web-push-notifications.md.`

- [ ] **Step 2: Add the `push` and `notificationclick` listeners**

Add after the existing `fetch` listener, at the end of the file:

```javascript
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const payload = event.data.json();
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      data: { url: payload.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      const existing = clients.find((c) => new URL(c.url).pathname === targetUrl);
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});
```

- [ ] **Step 3: Manually verify in a browser**

Run: `npx wrangler dev`
Open the app, DevTools → Application → Service Workers, confirm `wavelengthz-shell-v20` is active. Application → Service Workers → "Push" (Chrome's manual push-test button) with a JSON payload like `{"title":"Test","body":"Hello","url":"/matches"}` and confirm a notification appears and clicking it navigates to `/matches`.

- [ ] **Step 4: Commit**

```bash
git add public/sw.js
git commit -m "feat: handle push and notificationclick in the service worker"
```

---

### Task 5: Settings toggle + iOS install banner

**Files:**
- Modify: `public/app.js`
- Modify: `public/settings.js`
- Modify: `public/settings.html`
- Modify: `test/public/settings.test.ts`

**Interfaces:**
- Consumes: `GET /api/push/vapid-public-key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe` (Task 3).
- Produces: `createSettingsApp()` gains `pushSupported`, `pushEnabled`, `pushPermissionDenied`, `showIosInstallBanner` state and `enablePush()`, `disablePush()`, `dismissIosInstallBanner()` methods.

- [ ] **Step 1: Add the API helpers to `public/app.js`**

Add to the `api` object (anywhere — alphabetical/grouping isn't enforced elsewhere in this file):

```javascript
  pushVapidPublicKey: () => request('/api/push/vapid-public-key'),
  pushSubscribe: (subscription) =>
    request('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription) }),
  pushUnsubscribe: (endpoint) =>
    request('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) }),
```

- [ ] **Step 2: Extend `stubApi`'s fetch mock in `test/public/settings.test.ts` to handle the VAPID key endpoint**

`stubApi`'s existing catch-all branch returns `{ ok: true }` for any path it doesn't specifically recognize (`/api/me`, `/api/photos`) — the `enablePush()` test below needs a real `publicKey` back from `/api/push/vapid-public-key`, or it silently falls into `enablePush()`'s catch block instead of subscribing. In the existing `stubApi` function near the top of the file, change:

```javascript
    if (path === '/api/photos' && (!options.method || options.method === 'GET')) {
      return new Response(JSON.stringify({ photos }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
```

to:

```javascript
    if (path === '/api/photos' && (!options.method || options.method === 'GET')) {
      return new Response(JSON.stringify({ photos }), { status: 200 });
    }
    if (path === '/api/push/vapid-public-key') {
      return new Response(JSON.stringify({ publicKey: 'test-vapid-public-key' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
```

- [ ] **Step 3: Write the failing tests**

Append to `test/public/settings.test.ts`:

```typescript
function fakeServiceWorker(subscription) {
  return {
    ready: Promise.resolve({
      pushManager: {
        getSubscription: async () => subscription,
        subscribe: async () => ({
          endpoint: 'https://push.example/new',
          toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }),
        }),
      },
    }),
  };
}

describe('push notifications', () => {
  it('init() detects an existing subscription as pushEnabled', async () => {
    stubApi(ONBOARDED_USER);
    vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: false }), navigator: {} });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows)', serviceWorker: fakeServiceWorker({ endpoint: 'https://push.example/existing' }) });
    vi.stubGlobal('Notification', { permission: 'granted' });

    const app = createSettingsApp();
    await app.init();

    expect(app.pushSupported).toBe(true);
    expect(app.pushEnabled).toBe(true);

    vi.unstubAllGlobals();
  });

  it('enablePush() requests permission, subscribes, and posts the subscription', async () => {
    const { calls } = stubApi(ONBOARDED_USER);
    vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows)', serviceWorker: fakeServiceWorker(null) });
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' });

    const app = createSettingsApp();
    await app.init();
    await app.enablePush();

    expect(app.pushEnabled).toBe(true);
    const subscribeCall = calls.find((c) => c.path === '/api/push/subscribe');
    expect(JSON.parse(subscribeCall.options.body)).toEqual({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } });

    vi.unstubAllGlobals();
  });

  it('enablePush() sets pushPermissionDenied and does not subscribe when permission is denied', async () => {
    const { calls } = stubApi(ONBOARDED_USER);
    vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows)', serviceWorker: fakeServiceWorker(null) });
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'denied' });

    const app = createSettingsApp();
    await app.init();
    await app.enablePush();

    expect(app.pushEnabled).toBe(false);
    expect(app.pushPermissionDenied).toBe(true);
    expect(calls.some((c) => c.path === '/api/push/subscribe')).toBe(false);

    vi.unstubAllGlobals();
  });

  it('disablePush() unsubscribes and posts the endpoint to /api/push/unsubscribe', async () => {
    const { calls } = stubApi(ONBOARDED_USER);
    const unsubscribe = vi.fn(async () => true);
    vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows)',
      serviceWorker: fakeServiceWorker({ endpoint: 'https://push.example/existing', unsubscribe }),
    });
    vi.stubGlobal('Notification', { permission: 'granted' });

    const app = createSettingsApp();
    await app.init();
    await app.disablePush();

    expect(unsubscribe).toHaveBeenCalled();
    expect(app.pushEnabled).toBe(false);
    const unsubCall = calls.find((c) => c.path === '/api/push/unsubscribe');
    expect(JSON.parse(unsubCall.options.body)).toEqual({ endpoint: 'https://push.example/existing' });

    vi.unstubAllGlobals();
  });

  it('shows the iOS install banner only on non-standalone iOS Safari, and hides it once dismissed', async () => {
    stubApi(ONBOARDED_USER);
    const store = {};
    vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    vi.stubGlobal('localStorage', { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } });

    const app = createSettingsApp();
    await app.init();
    expect(app.showIosInstallBanner).toBe(true);

    app.dismissIosInstallBanner();
    expect(app.showIosInstallBanner).toBe(false);

    const app2 = createSettingsApp();
    await app2.init();
    expect(app2.showIosInstallBanner).toBe(false); // dismissal persisted

    vi.unstubAllGlobals();
  });

  it('does not show the iOS install banner on Android', async () => {
    stubApi(ONBOARDED_USER);
    vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14)' });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });

    const app = createSettingsApp();
    await app.init();
    expect(app.showIosInstallBanner).toBe(false);

    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/public/settings.test.ts`
Expected: FAIL — none of the new state/methods exist yet.

- [ ] **Step 5: Add a module-level helper and new state fields to `public/settings.js`**

Add near the top of the file, after the existing constants:

```javascript
// Converts the VAPID public key (base64url, from GET /api/push/vapid-public-key)
// into the Uint8Array pushManager.subscribe()'s applicationServerKey expects.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}
```

Add to the returned object's state (alongside `hasSpotify`):

```javascript
    pushSupported: false,
    pushEnabled: false,
    pushPermissionDenied: false,
    showIosInstallBanner: false,
```

- [ ] **Step 6: Wire detection into `init()`**

Inside the existing `if (typeof window !== 'undefined') { ... }` block in `init()` (the one that already handles `spotify_connected`/`spotify_error` query params), add before its closing brace:

```javascript
        const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);
        const isStandalone = window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator?.standalone === true;
        this.showIosInstallBanner = isIos && !isStandalone && !localStorage.getItem('wl_ios_install_dismissed');

        this.pushSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof Notification !== 'undefined';
        if (this.pushSupported) {
          this.pushPermissionDenied = Notification.permission === 'denied';
          const registration = await navigator.serviceWorker.ready;
          const existingSubscription = await registration.pushManager.getSubscription();
          this.pushEnabled = existingSubscription != null;
        }
```

- [ ] **Step 7: Add `enablePush()`, `disablePush()`, `dismissIosInstallBanner()`**

Add these methods to the returned object (near `logout()`):

```javascript
    async enablePush() {
      this.error = null;
      try {
        const permission = await Notification.requestPermission();
        this.pushPermissionDenied = permission === 'denied';
        if (permission !== 'granted') return;

        const { publicKey } = await api.pushVapidPublicKey();
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        await api.pushSubscribe(subscription.toJSON());
        this.pushEnabled = true;
      } catch (e) {
        console.error('Enable notifications failed:', e);
        this.error = 'Could not enable notifications. Please try again.';
      }
    },

    async disablePush() {
      this.error = null;
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await api.pushUnsubscribe(subscription.endpoint);
          await subscription.unsubscribe();
        }
        this.pushEnabled = false;
      } catch (e) {
        console.error('Disable notifications failed:', e);
        this.error = 'Could not disable notifications. Please try again.';
      }
    },

    dismissIosInstallBanner() {
      this.showIosInstallBanner = false;
      if (typeof localStorage !== 'undefined') localStorage.setItem('wl_ios_install_dismissed', '1');
    },
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/public/settings.test.ts`
Expected: PASS (all cases green, including every pre-existing test unaffected)

- [ ] **Step 9: Add the markup to `public/settings.html`**

Add after the existing Spotify blocks (`x-show="hasSpotify"` / `x-show="!hasSpotify"`) and before the `info`/`error`/`saved` status paragraphs:

```html
  <div x-show="showIosInstallBanner" class="card mx-auto mb-4 max-w-md p-4 text-sm">
    <p class="font-semibold text-neutral-200">Get notifications on iPhone</p>
    <p class="mt-1 text-neutral-400">Tap the Share button, then "Add to Home Screen" -- notifications only work once Wavelengthz is installed this way.</p>
    <button type="button" class="btn-ghost mt-2" @click="dismissIosInstallBanner()">Got it</button>
  </div>

  <div x-show="pushSupported" class="card mx-auto mb-4 flex max-w-md items-center justify-between p-4">
    <div class="text-sm">
      <p class="font-semibold text-neutral-200">Notifications</p>
      <p class="text-neutral-500" x-show="!pushPermissionDenied">Get notified about new matches and messages.</p>
      <p class="text-neutral-500" x-show="pushPermissionDenied">Blocked in your browser settings -- notifications can't be re-requested from here.</p>
    </div>
    <button type="button" class="btn-secondary" :disabled="pushPermissionDenied" @click="pushEnabled ? disablePush() : enablePush()">
      <span x-text="pushEnabled ? 'On' : 'Off'"></span>
    </button>
  </div>
```

- [ ] **Step 10: Run the full suite and type-check**

Run: `npx vitest run` and `npx tsc --noEmit`
Expected: all green, zero errors.

- [ ] **Step 11: Commit**

```bash
git add public/app.js public/settings.js public/settings.html test/public/settings.test.ts
git commit -m "feat: add notification toggle and iOS install banner to Settings"
```

---

### Task 6: Close out the backlog item

**Files:**
- None (GitHub issue update only).

- [ ] **Step 1: Strike through the backlog line in issue #2**

Change:

```markdown
* Can this application tool up Push notifications on iphone and android?
```

to:

```markdown
* ~~Can this application tool up Push notifications on iphone and android?~~ (fixed in [#<PR number>](<PR URL>))
```

(Confirm with the user before editing — it's a shared, visible artifact — per this project's established workflow.)
