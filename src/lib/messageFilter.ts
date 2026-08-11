export const MAX_MESSAGE_LENGTH = 2000;

// Alphanumeric, spaces, and a small set of basic punctuation -- enough for
// normal sentences ("don't", "what's up?", "auto-refresh") while still
// blocking links, emoji, and markup. Hyphen is first in the character class
// (not last before ']') -- a trailing hyphen is ambiguous under RegExp's `v`
// flag; see the same fix in src/routes/onboarding.ts. Must stay in sync with
// the client-side pre-checks in public/messages.html and public/group.html.
const ALLOWED_CHARS_RE = /^[-A-Za-z0-9 .,!?']*$/;

// Deliberately small and conservative -- a static blocklist is not an
// exhaustive profanity filter (that's an arms race no static list wins), just
// a first line of defense against the most common cases.
const BLOCKED_WORDS = new Set(['fuck', 'fucking', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot']);

// Exported: also used on bios (src/routes/onboarding.ts) so profile language
// is held to the same bar as message language, without pulling in
// isValidMessageBody's other message-specific rules (length, link/emoji
// lockdown) that don't apply to a bio.
export function containsBlockedWord(body: string): boolean {
  const words = body.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  return words.some((w) => BLOCKED_WORDS.has(w));
}

export function isValidMessageBody(body: string): boolean {
  if (typeof body !== 'string') return false;
  const trimmed = body.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_MESSAGE_LENGTH) return false;
  if (!ALLOWED_CHARS_RE.test(trimmed)) return false;
  if (containsBlockedWord(trimmed)) return false;
  return true;
}
