-- Migration number: 0005 	 2026-08-08T21:03:39.040Z

-- Set once a user has been reported by 3+ distinct people (src/lib/
-- reports.ts's GHOST_REPORT_THRESHOLD, applied in src/routes/safety.ts).
-- Deliberately NOT a delete or a "removed" flag the ghosted user can see:
-- they keep using the app normally, unaware -- everyone else just stops
-- being able to see or interact with them (src/routes/peopleSwipes.ts,
-- src/lib/matching.ts, src/routes/matches.ts).
ALTER TABLE users ADD COLUMN ghosted_at INTEGER;
