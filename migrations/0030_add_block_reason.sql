-- Issue #173 (Round 8): "give the report and block functionality the 'why'
-- w/ an 'other' text field option." POST /api/report already had reason +
-- details columns (migrations/0001_baseline_schema.sql) but no UI ever
-- collected them beyond a raw prompt() asking someone to type an enum
-- value from memory -- see src/routes/safety.ts's VALID_REASONS. `blocks`
-- had no reason column at all: blocking has always been silent.
--
-- Both nullable: blocking stays a no-explanation-needed action (Terms of
-- Service §6 -- "entirely your own choice"), so a member can still block
-- without picking a reason if the client ever allows that; `reason` is
-- validated against the same VALID_REASONS set as reports when present.
ALTER TABLE blocks ADD COLUMN reason TEXT;
ALTER TABLE blocks ADD COLUMN details TEXT;
