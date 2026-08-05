// Shared between 1:1 messages (src/routes/matches.ts) and group messages
// (src/routes/groups.ts) -- both use the identical eligibility rule: only
// the sender, only once, only within RECALL_WINDOW_MS of sending.
export const RECALL_WINDOW_MS = 15 * 1000;

export interface RecallableMessage {
  sender_id: string;
  created_at: number;
  recalled_at: number | null;
}

export type RecallCheck = { ok: true } | { ok: false; error: 'not_sender' | 'already_recalled' | 'recall_window_expired' };

export function canRecall(message: RecallableMessage, userId: string, now: number): RecallCheck {
  if (message.sender_id !== userId) return { ok: false, error: 'not_sender' };
  if (message.recalled_at) return { ok: false, error: 'already_recalled' };
  if (now - message.created_at > RECALL_WINDOW_MS) return { ok: false, error: 'recall_window_expired' };
  return { ok: true };
}
