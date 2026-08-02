import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../src/lib/crypto';

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
