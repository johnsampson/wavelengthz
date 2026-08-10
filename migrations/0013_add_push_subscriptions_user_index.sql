-- Migration number: 0013 	 2026-08-09T22:16:35.423Z

-- notifyMatch/notifyMessage (src/lib/notifications.ts) and the cron sweep's
-- EXISTS subquery all filter push_subscriptions by user_id, but 0012 never
-- indexed it -- matching idx_sessions_user/idx_notifications_user's existing
-- pattern for FK/lookup columns elsewhere in this schema.
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
