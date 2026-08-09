-- Migration number: 0007 	 2026-08-09T00:45:00.000Z

-- A user's chosen "anthem" -- one track from their own Spotify top tracks
-- that plays from a tap on their swipe-deck card (public/index.html) and is
-- badged on their full profile (public/profile.html). Stored as a soft
-- reference to music_profiles.top_tracks' track_id, not a foreign key:
-- top_tracks is a JSON blob refreshed independently of this column, so a
-- track can legitimately fall out of it later. src/lib/profile.ts's
-- pickAnthemTrack treats "no longer in top_tracks" as no anthem set, rather
-- than erroring.
ALTER TABLE users ADD COLUMN anthem_track_id TEXT;
