import { describe, it, expect } from 'vitest';
import { canRecall, RECALL_WINDOW_MS } from '../../src/lib/messageRecall';

describe('canRecall', () => {
  it('allows the sender to recall within the window', () => {
    const now = 1_000_000;
    const message = { sender_id: 'u1', created_at: now - 5000, recalled_at: null };
    expect(canRecall(message, 'u1', now)).toEqual({ ok: true });
  });

  it('allows a recall right at the edge of the window', () => {
    const now = 1_000_000;
    const message = { sender_id: 'u1', created_at: now - RECALL_WINDOW_MS, recalled_at: null };
    expect(canRecall(message, 'u1', now)).toEqual({ ok: true });
  });

  it('rejects once the window has passed', () => {
    const now = 1_000_000;
    const message = { sender_id: 'u1', created_at: now - RECALL_WINDOW_MS - 1, recalled_at: null };
    expect(canRecall(message, 'u1', now)).toEqual({ ok: false, error: 'recall_window_expired' });
  });

  it('rejects someone other than the sender', () => {
    const now = 1_000_000;
    const message = { sender_id: 'u1', created_at: now - 1000, recalled_at: null };
    expect(canRecall(message, 'u2', now)).toEqual({ ok: false, error: 'not_sender' });
  });

  it('rejects a message that was already recalled', () => {
    const now = 1_000_000;
    const message = { sender_id: 'u1', created_at: now - 1000, recalled_at: now - 500 };
    expect(canRecall(message, 'u1', now)).toEqual({ ok: false, error: 'already_recalled' });
  });
});
