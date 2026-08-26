import { describe, it, expect } from 'vitest';
import { containsBlockedWord, isValidMessageBody, isValidTrackCaption, MAX_MESSAGE_LENGTH } from '../../src/lib/messageFilter';

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

  it('rejects characters outside alphanumeric/space/basic punctuation/emoji', () => {
    expect(isValidMessageBody('Check out http://evil.example')).toBe(false); // ':' and '/'
    expect(isValidMessageBody('<script>alert(1)</script>')).toBe(false);
    expect(isValidMessageBody('#hashtag')).toBe(false); // markup, not emoji
  });

  it('accepts the standard emoji set', () => {
    expect(isValidMessageBody('Emoji time 😀')).toBe(true);
    expect(isValidMessageBody('Nice 👍🏽 job')).toBe(true); // skin-tone modifier
    expect(isValidMessageBody('See you in the 🇺🇸')).toBe(true); // flag (regional indicators)
    expect(isValidMessageBody('👨‍👩‍👧‍👦 family trip')).toBe(true); // ZWJ sequence
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

// Exported for reuse on bios (src/routes/onboarding.ts) -- profile language
// held to the same bar as message language, without pulling in
// isValidMessageBody's other message-specific rules (length, link/markup
// lockdown) that don't make sense for a bio.
describe('containsBlockedWord', () => {
  it('flags a blocked word case-insensitively and as a whole word', () => {
    expect(containsBlockedWord('such a fucking mess')).toBe(true);
    expect(containsBlockedWord('such a FUCKING mess')).toBe(true);
  });

  it('does not flag ordinary text or a word that merely contains a blocked substring', () => {
    expect(containsBlockedWord('I love live music and loud guitars')).toBe(false);
    expect(containsBlockedWord('that concert was a classic show')).toBe(false);
  });
});

describe('isValidTrackCaption', () => {
  it('allows an omitted or empty caption -- sending just the song is the common case', () => {
    expect(isValidTrackCaption(undefined)).toBe(true);
    expect(isValidTrackCaption(null)).toBe(true);
    expect(isValidTrackCaption('')).toBe(true);
    expect(isValidTrackCaption('   ')).toBe(true);
  });

  it('holds a non-empty caption to the same bar as any other message', () => {
    expect(isValidTrackCaption('this one is you')).toBe(true);
    expect(isValidTrackCaption('http://evil.example')).toBe(false); // charset blocks links
    expect(isValidTrackCaption('you are a bitch')).toBe(false); // blocklist still applies
    expect(isValidTrackCaption('x'.repeat(2001))).toBe(false);
  });

  it('rejects a non-string caption', () => {
    expect(isValidTrackCaption(42 as any)).toBe(false);
    expect(isValidTrackCaption({} as any)).toBe(false);
  });

  it('leaves isValidMessageBody itself unchanged -- empty is still invalid there', () => {
    expect(isValidMessageBody('')).toBe(false);
    expect(isValidMessageBody('   ')).toBe(false);
  });
});
