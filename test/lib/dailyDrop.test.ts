import { describe, it, expect, beforeAll } from 'vitest';
import { currentDayIndex, promptSortOrderForDay, DAILY_PROMPT_BANK_SIZE } from '../../src/lib/dailyDrop';
import { applySchema } from '../apply-schema';
import { env } from 'cloudflare:test';

describe('currentDayIndex', () => {
  it('returns the same value for two timestamps on the same UTC calendar day', () => {
    const morning = Date.UTC(2026, 0, 15, 1, 0, 0);
    const night = Date.UTC(2026, 0, 15, 23, 59, 0);
    expect(currentDayIndex(morning)).toBe(currentDayIndex(night));
  });

  it('advances by exactly one across a UTC midnight boundary', () => {
    const beforeMidnight = Date.UTC(2026, 0, 15, 23, 59, 59);
    const afterMidnight = Date.UTC(2026, 0, 16, 0, 0, 0);
    expect(currentDayIndex(afterMidnight)).toBe(currentDayIndex(beforeMidnight) + 1);
  });
});

describe('promptSortOrderForDay', () => {
  it('returns a value in [1, DAILY_PROMPT_BANK_SIZE]', () => {
    for (let day = 0; day < 500; day++) {
      const sortOrder = promptSortOrderForDay(day);
      expect(sortOrder).toBeGreaterThanOrEqual(1);
      expect(sortOrder).toBeLessThanOrEqual(DAILY_PROMPT_BANK_SIZE);
    }
  });

  it('repeats with exactly the bank size as its period', () => {
    for (let day = 0; day < 200; day++) {
      expect(promptSortOrderForDay(day + DAILY_PROMPT_BANK_SIZE)).toBe(promptSortOrderForDay(day));
    }
  });

  it('never returns the same sort_order for two different days within one cycle', () => {
    const seen = new Set<number>();
    for (let day = 0; day < DAILY_PROMPT_BANK_SIZE; day++) {
      const sortOrder = promptSortOrderForDay(day);
      expect(seen.has(sortOrder)).toBe(false);
      seen.add(sortOrder);
    }
    expect(seen.size).toBe(DAILY_PROMPT_BANK_SIZE);
  });

  it('handles a negative day index without throwing or going out of range', () => {
    expect(promptSortOrderForDay(-1)).toBeGreaterThanOrEqual(1);
    expect(promptSortOrderForDay(-1)).toBeLessThanOrEqual(DAILY_PROMPT_BANK_SIZE);
  });
});

// Guards the seed data in migrations/0025 itself, not just the pure rotation
// math above -- this is what would actually catch DAILY_PROMPT_BANK_SIZE
// drifting out of sync with the real row count, or the launch-sequence /
// heavy-prompt-spacing decisions silently regressing on a future edit.
describe('daily_prompts seed data (migrations/0025)', () => {
  beforeAll(async () => {
    await applySchema(env.DB);
  });

  it('has exactly DAILY_PROMPT_BANK_SIZE rows, sort_order 1..N with no gaps or duplicates', async () => {
    const rows = await env.DB.prepare('SELECT sort_order FROM daily_prompts ORDER BY sort_order ASC').all<{ sort_order: number }>();
    const sortOrders = rows.results.map((r) => r.sort_order);
    expect(sortOrders).toEqual(Array.from({ length: DAILY_PROMPT_BANK_SIZE }, (_, i) => i + 1));
  });

  it("keeps the source doc's exact 10-prompt launch sequence in positions 1-10", async () => {
    const rows = await env.DB.prepare('SELECT text FROM daily_prompts WHERE sort_order <= 10 ORDER BY sort_order ASC').all<{
      text: string;
    }>();
    expect(rows.results.map((r) => r.text)).toEqual([
      "What's on repeat right now?",
      "The song you'd never skip, no matter what you're doing.",
      'The song that puts you in a good mood, every time.',
      "A song you loved at 15 that you'd still defend.",
      'The most embarrassing song you genuinely love.',
      'What you put on when you need to disappear for a while.',
      'The song you send someone when you want them to get you.',
      'Last thing you played driving alone at night.',
      "The artist you'd drop everything to go see live.",
      "A song that reminds you of someone you don't talk to anymore.",
    ]);
  });

  it('spaces the heavy (intensity 3) prompts at least 8 positions apart, cyclically', async () => {
    const rows = await env.DB.prepare('SELECT sort_order FROM daily_prompts WHERE intensity = 3 ORDER BY sort_order ASC').all<{
      sort_order: number;
    }>();
    const positions = rows.results.map((r) => r.sort_order);
    expect(positions.length).toBeGreaterThan(0);
    for (let i = 0; i < positions.length; i++) {
      const next = positions[(i + 1) % positions.length];
      const forwardGap = next > positions[i] ? next - positions[i] : DAILY_PROMPT_BANK_SIZE - positions[i] + next;
      expect(forwardGap).toBeGreaterThanOrEqual(8);
    }
  });
});
