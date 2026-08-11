-- Migration number: 0017 	 2026-08-11T00:00:00.000Z

-- Image moderation (issue #36 §2, src/lib/sightengine.ts). 'pending' is the
-- column default for defensive completeness (any future insert path that
-- forgets to set this explicitly lands in the safest state, not the most
-- permissive one) -- application code always sets a real value itself:
-- 'approved' immediately when SIGHTENGINE_API_USER/SECRET aren't configured
-- yet (today's behavior, unchanged -- no moderation capability exists
-- without credentials, same as none existed before this migration), or a
-- real classification once they are. moderation_checked_at stays NULL in
-- that no-credentials case specifically, distinguishing "never actually
-- checked" from "checked and found clean" -- both distinctions this table's
-- other enrichment columns (e.g. artists.genre_enriched_at) already use.
ALTER TABLE user_photos ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE user_photos ADD COLUMN moderation_score REAL;
ALTER TABLE user_photos ADD COLUMN moderation_checked_at INTEGER;

-- Existing photos predate moderation entirely -- defaulting them to
-- 'pending' would make GET /photos/:id's new "only the owner can see a
-- non-approved photo" rule retroactively hide every photo already live in
-- production the moment this migration runs. Treated as approved instead,
-- same as they effectively were (visible to everyone) the instant before
-- this migration -- not re-litigated by a moderation system that didn't
-- exist yet when they were uploaded.
UPDATE user_photos SET moderation_status = 'approved';

