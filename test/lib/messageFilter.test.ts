import { describe, it, expect } from 'vitest';
import { isValidMessageBody, MAX_MESSAGE_LENGTH } from '../../src/lib/messageFilter';

describe('isValidMessageBody', () => {
  it('accepts a normal sentence with common punctuation', () => {
    expect(isValidMessageBody("Hey, what's up? Nice to meet you!")).toBe(true);
  });

  it('accepts plain alphanumeric text', () => {
    expect(isValidMessageBody('See you at 8pm')).toBe(true);
  });

  it('rejects an empty or whitespace-only body', () => {
    expect(isValidMessageBody('')).toBe(false);
    expect(isValidMessageBody('   ')).toBe(false);
  });

  it('rejects a body over the max length', () => {
    expect(isValidMessageBody('a'.repeat(MAX_MESSAGE_LENGTH))).toBe(true);
    expect(isValidMessageBody('a'.repeat(MAX_MESSAGE_LENGTH + 1))).toBe(false);
  });

  it('rejects characters outside alphanumeric/space/basic punctuation', () => {
    expect(isValidMessageBody('Check out http://evil.example')).toBe(false); // ':' and '/'
    expect(isValidMessageBody('Emoji time 😀')).toBe(false);
    expect(isValidMessageBody('<script>alert(1)</script>')).toBe(false);
  });

  it('rejects bodies containing a blocked word, case-insensitively and as a whole word', () => {
    expect(isValidMessageBody('you are a fucking idiot')).toBe(false);
    expect(isValidMessageBody('you are a FUCKING idiot')).toBe(false);
  });

  it('accepts a hyphen -- both client-side pre-checks (messages.html, group.html) already allow it', () => {
    expect(isValidMessageBody('Testing the auto-refresh')).toBe(true);
  });

  it('does not flag a word that merely contains a blocked substring', () => {
    // Regression guard: a naive substring check would false-positive on
    // "classic" (contains "ass") or "Scunthorpe"-style names.
    expect(isValidMessageBody('that concert was a classic show')).toBe(true);
  });
});
