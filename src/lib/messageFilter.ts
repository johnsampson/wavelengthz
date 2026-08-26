export const MAX_MESSAGE_LENGTH = 2000;

// Alphanumeric, spaces, a small set of basic punctuation, and the standard
// emoji set -- enough for normal sentences ("don't", "what's up?",
// "auto-refresh") plus a 😀 or 👍🏽 or 🇺🇸 or 👨‍👩‍👧‍👦 dropped in, while still
// blocking links and markup. \p{Extended_Pictographic} covers the emoji
// pictographs themselves; \p{Emoji_Modifier} is the Fitzpatrick skin-tone
// modifiers (👍🏽); \p{Regional_Indicator} is the letter-pair components flag
// emoji are built from (🇺🇸); \u{200D} (zero-width joiner) and \u{FE0F}
// (variation selector-16, forces emoji presentation) are what stitch a
// multi-codepoint sequence like a family emoji into one glyph instead of
// several. Deliberately NOT \p{Emoji} alone -- that broader property also
// covers plain '#'/'*'/digits (keycap-sequence components), which would
// silently reopen the existing "no markup" stance for '#'. Requires the `u`
// flag for the \p{...}/\u{...} escapes to work at all. Hyphen is first in
// the character class (not last before ']') -- a trailing hyphen is
// ambiguous under RegExp's `v` flag; see the same fix in
// src/routes/onboarding.ts (this regex stays on `u`, not `v`, but the same
// habit costs nothing and keeps every character class in this codebase
// consistent). Must stay in sync with the client-side pre-checks in
// public/messages.js and public/group.js.
const ALLOWED_CHARS_RE =
  /^[-A-Za-z0-9 .,!?'\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{200D}\u{FE0F}]*$/u;

// Deliberately small and conservative -- a static blocklist is not an
// exhaustive profanity filter (that's an arms race no static list wins), just
// a first line of defense against the most common cases.
const BLOCKED_WORDS = new Set(['fuck', 'fucking', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot']);

// Exported: also used on bios (src/routes/onboarding.ts) so profile language
// is held to the same bar as message language, without pulling in
// isValidMessageBody's other message-specific rules (length, link/markup
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

/**
 * A shared track (migrations/0021) carries an OPTIONAL caption rather than a
 * required body -- sending just the song, with nothing said, is the most
 * common and most natural form of it. So the rule inverts: an empty body is
 * fine here (and only here), but a non-empty one still has to clear every
 * check a plain text message does, since a caption is just as visible as any
 * other message.
 *
 * Deliberately NOT folded into isValidMessageBody as an "allow empty" flag:
 * that function's contract ("this string is safe to show another user") is
 * relied on by bios too, and quietly teaching it to accept empty strings
 * would weaken it everywhere for the benefit of one caller.
 */
export function isValidTrackCaption(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body !== 'string') return false;
  if (!body.trim()) return true;
  return isValidMessageBody(body);
}
