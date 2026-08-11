-- Migration number: 0020 	 2026-08-05T17:48:07.607Z
-- Renumbered twice during rebases onto main: originally 0004, then 0016
-- (both already claimed -- by migrations/0004_add_age_range.sql, then by
-- migrations/0016_add_genre_pass_tracking_and_blocking.sql -- by the time
-- this long-lived branch caught up each time). Original authoring date
-- kept above for history.

-- Backend-only Twilio Verify integration (src/lib/twilio.ts,
-- src/routes/phone.ts). phone_number is only ever written on a successful
-- POST /api/phone/verify/check -- there's no "pending" state to persist,
-- since Twilio's Verify service already tracks the in-flight verification
-- for us. NULL until then, so the unique index doesn't conflict between
-- unverified users (SQLite treats multiple NULLs as distinct under UNIQUE).
ALTER TABLE users ADD COLUMN phone_number TEXT;
ALTER TABLE users ADD COLUMN phone_verified_at INTEGER;
CREATE UNIQUE INDEX idx_users_phone_number ON users(phone_number);
