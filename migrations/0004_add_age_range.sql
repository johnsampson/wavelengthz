-- Migration number: 0004 	 2026-08-07T19:05:02.000Z

-- Candidate search age preference (settings.html), same shape as
-- max_distance_km: a filter enforced in code (src/routes/peopleSwipes.ts),
-- not just a scoring weight. Defaults give existing rows the full range, so
-- this is a no-op for candidate search until a user actually narrows it.
ALTER TABLE users ADD COLUMN age_min INTEGER NOT NULL DEFAULT 18;
ALTER TABLE users ADD COLUMN age_max INTEGER NOT NULL DEFAULT 100;
