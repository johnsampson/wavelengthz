import { describe, it, expect } from 'vitest';
import { createPresignedUploadUrl } from '../../src/lib/r2';

const env = {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'secretkey',
  R2_BUCKET_NAME: 'wavelengthz-photos',
} as any;

describe('createPresignedUploadUrl', () => {
  it('returns a URL against the R2 S3 endpoint with SigV4 query params', async () => {
    const url = new URL(await createPresignedUploadUrl(env, 'users/u1/photo-1.jpg', 'image/jpeg', 300));
    expect(url.hostname).toBe('acct123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/wavelengthz-photos/users/u1/photo-1.jpg');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-Credential')).toContain('AKIDEXAMPLE');
  });

  it('produces a different signature for a different key', async () => {
    const urlA = await createPresignedUploadUrl(env, 'a.jpg', 'image/jpeg', 300);
    const urlB = await createPresignedUploadUrl(env, 'b.jpg', 'image/jpeg', 300);
    expect(new URL(urlA).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(urlB).searchParams.get('X-Amz-Signature')
    );
  });
});
