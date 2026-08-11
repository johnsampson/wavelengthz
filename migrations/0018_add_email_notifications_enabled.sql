-- Migration number: 0018 	 2026-08-11T00:00:00.000Z

-- Explicit per-user opt-out for notification emails (matches, messages --
-- src/lib/notifications.ts), independent of push. Default 1 (on) matches
-- today's actual behavior for every existing row: notifyMatch/notifyMessage
-- already email whenever push wasn't used and an address is on file, with
-- no way to turn that off -- this column adds the off switch without
-- changing anyone's current experience the moment this migration runs.
ALTER TABLE users ADD COLUMN email_notifications_enabled INTEGER NOT NULL DEFAULT 1;
