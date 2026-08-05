-- Migration number: 0003 	 2026-08-05T17:28:26.149Z

-- Lets a sender recall (not delete) a message within RECALL_WINDOW_MS of
-- sending it (src/lib/messageRecall.ts). The row -- and its original body --
-- is kept for moderation/audit, matching this app's existing soft-delete
-- conventions (soft-deleted users, unmatched matches); GET /api/matches/:id/
-- messages and GET /api/groups/:id/messages null out `body` in the API
-- response once recalled_at is set, so recalled content never actually
-- reaches other participants' clients.
ALTER TABLE messages ADD COLUMN recalled_at INTEGER;
ALTER TABLE group_messages ADD COLUMN recalled_at INTEGER;
