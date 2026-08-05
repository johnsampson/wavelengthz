import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, constantTimeEqual } from '../../src/lib/crypto';

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='; // base64, 32 bytes

describe('crypto', () => {
  it('round-trips plaintext through encrypt/decrypt', async () => {
    const ciphertext = await encrypt('spotify-refresh-token-abc123', KEY);
    expect(ciphertext).not.toContain('spotify-refresh-token-abc123');
    const plaintext = await decrypt(ciphertext, KEY);
    expect(plaintext).toBe('spotify-refresh-token-abc123');
  });

  it('produces different ciphertext for the same plaintext on repeat calls', async () => {
    const a = await encrypt('same-input', KEY);
    const b = await encrypt('same-input', KEY);
    expect(a).not.toBe(b); // random IV each time
  });
});

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('super-secret', 'super-secret')).toBe(true);
  });

  it('returns false for a mismatch of the same length', () => {
    expect(constantTimeEqual('super-secret', 'super-secreT')).toBe(false);
  });

  it('returns false for different lengths without throwing', () => {
    expect(constantTimeEqual('short', 'a-much-longer-string')).toBe(false);
  });

  it('returns false when compared against an empty string', () => {
    expect(constantTimeEqual('super-secret', '')).toBe(false);
  });
});
