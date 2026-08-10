-- Migration number: 0014 	 2026-08-09T14:25:30.666Z

-- One row per browser/device push subscription. `endpoint UNIQUE` is the
-- natural dedupe key -- subscribing again with the same endpoint (e.g. the
-- Settings toggle re-enabled) is an upsert, not a new row. A 404/410 from
-- the push service means the subscription is gone; src/lib/notifications.ts
-- deletes that row rather than retrying it forever.
--
-- created_at/updated_at per CLAUDE.md's schema convention (adopted in 0010/
-- 0011, just ahead of this migration in the merged history) -- updated_at
-- is touched on the ON CONFLICT re-subscribe/re-point-ownership path in
-- src/routes/push.ts, not just set once at insert.
CREATE TABLE push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
