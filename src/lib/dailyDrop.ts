// The Daily Drop's prompt rotation. Deliberately a pure function of time
// rather than stored, mutable "which prompt is today" state -- see
// migrations/0025's comment for why: no cron needed to advance it, and no
// race between two concurrent first-viewers of a fresh day.

// Grows the moment the prompt bank does (migrations/0025's own comment
// notes the doc's real target is ~90, this is a first-stab 48) -- a single
// constant here, not a magic number scattered across call sites.
export const DAILY_PROMPT_BANK_SIZE = 48;

/**
 * Which UTC calendar day `now` (epoch ms) falls on, as a whole-day count
 * since the Unix epoch. The unit that matters here is "a day," not a
 * timestamp -- two calls anywhere in the same UTC calendar day always
 * return the same value.
 */
export function currentDayIndex(now: number): number {
  return Math.floor(now / 86_400_000);
}

/**
 * Maps a day index onto a `daily_prompts.sort_order` (1-indexed, matching
 * the column's own numbering) in a fixed, repeating cycle. Stable across
 * however far `now` drifts -- the same day index always resolves to the
 * same prompt, forever, without needing to store anything.
 */
export function promptSortOrderForDay(dayIndex: number): number {
  return (((dayIndex % DAILY_PROMPT_BANK_SIZE) + DAILY_PROMPT_BANK_SIZE) % DAILY_PROMPT_BANK_SIZE) + 1;
}
