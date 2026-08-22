-- Migration number: 0026 	 2026-08-22T06:00:00.000Z

-- Invite-only signup gate, gender-balanced (docs/superpowers/specs/
-- 2026-08-09-gender-balanced-invite-gate-design.md). Off by default --
-- INVITE_ONLY (wrangler.toml) is empty in every environment today, so this
-- table exists and gets populated (every completed onboarding grants
-- codes), but nothing yet requires one to sign up.
--
-- code is NOT the primary key -- id is, per CLAUDE.md's schema conventions
-- -- but it's what's actually looked up on every /join and /callback
-- request, hence its own UNIQUE index below rather than relying on a scan.
CREATE TABLE invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  -- NULL for a system/admin-issued founding code (POST /api/admin/invites/
  -- generate) -- there's no member behind those.
  created_by_user_id TEXT REFERENCES users(id),
  -- 'male' | 'female' | NULL. NULL is an admin code usable by either gender;
  -- a member-issued code always names the opposite of the gender they
  -- declared at onboarding -- see src/routes/onboarding.ts's grant-on-first-
  -- completion logic. Self-attested at redemption (GET /join's "Continue"
  -- button), never re-checked against whatever the redeemer later picks in
  -- their own onboarding -- see the design doc for why re-validating there
  -- would be a dead end (the account already exists and the code is already
  -- spent by then).
  target_gender TEXT,
  redeemed_by_user_id TEXT REFERENCES users(id),
  redeemed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_invite_codes_created_by ON invite_codes(created_by_user_id);

-- Recorded at signup for a "who did I bring in" display in Settings later
-- (not built in this migration's own PR -- see docs' "Your Invites" panel).
-- Nullable: every account that existed before this migration, plus every
-- admin-founding-code redemption, has no inviter.
ALTER TABLE users ADD COLUMN invited_by_code_id TEXT REFERENCES invite_codes(id);
