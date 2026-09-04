-- Issue #173 (Round 8): "make messaging and social requirements require
-- agreeing to and visiting guidelines, safety tips, etc, each
-- independently." Terms of Service and the Privacy Policy already have an
-- implied-consent moment (the "By continuing, you agree to our Terms and
-- Privacy Policy" line under the sign-in buttons on public/login.html,
-- present before any account exists) -- Community Guidelines and Safety
-- Tips never had an equivalent moment for an already-signed-up member, so
-- those are the two this adds explicit, independent tracking for.
--
-- Both nullable: unacknowledged is the default for every existing account,
-- same as every other messagingGate.ts requirement (bio/photos/etc. all
-- start unmet too).
ALTER TABLE users ADD COLUMN guidelines_acknowledged_at INTEGER;
ALTER TABLE users ADD COLUMN safety_tips_acknowledged_at INTEGER;
