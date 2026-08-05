-- Migration number: 0016 	 2026-08-05T17:48:07.607Z
-- Renumbered from 0004 during a rebase onto main -- that number was already
-- claimed by migrations/0004_add_age_range.sql by the time this branch
-- caught up. Original authoring date kept above for history.

-- Backend-only Twilio Verify integration (src/lib/twilio.ts,
-- src/routes/phone.ts). phone_number is only ever written on a successful
-- POST /api/phone/verify/check -- there's no "pending" state to persist,
-- since Twilio's Verify service already tracks the in-flight verification
-- for us. NULL until then, so the unique index doesn't conflict between
-- unverified users (SQLite treats multiple NULLs as distinct under UNIQUE).
ALTER TABLE users ADD COLUMN phone_number TEXT;
ALTER TABLE users ADD COLUMN phone_verified_at INTEGER;
CREATE UNIQUE INDEX idx_users_phone_number ON users(phone_number);
