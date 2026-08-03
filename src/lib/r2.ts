async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function amzDate(now: Date): { date: string; dateTime: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { date: iso.slice(0, 8), dateTime: iso };
}

export async function createPresignedUploadUrl(
  env: Env,
  key: string,
  contentType: string,
  expiresInSeconds: number
): Promise<string> {
  const region = 'auto';
  const service = 's3';
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const { date, dateTime } = amzDate(new Date());
  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const credential = `${env.R2_ACCESS_KEY_ID}/${credentialScope}`;

  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': dateTime,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  });
  query.sort();

  const canonicalRequest = [
    'PUT',
    `/${env.R2_BUCKET_NAME}/${key}`,
    query.toString(),
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateTime,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(new TextEncoder().encode('AWS4' + env.R2_SECRET_ACCESS_KEY), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  query.set('X-Amz-Signature', signature);

  return `https://${host}/${env.R2_BUCKET_NAME}/${key}?${query.toString()}`;
}
