-- Two additions supporting "did this listen actually reach Spotify's 30s
-- royalty threshold, and can we make that more likely".

-- duration_ms rides along free in every Spotify track payload this app
-- already fetches (search results, album tracks, currently-playing) -- it was
-- simply being discarded. Needed to pick a sensible "start at the hook"
-- offset: a fixed number of seconds is wrong for both a 90-second punk song
-- and a 9-minute prog track, so the offset is a fraction of the real
-- duration, clamped (see public/playHeuristics.js). Nullable: every existing
-- row predates this, and an unknown duration simply falls back to starting at
-- 0:00.
ALTER TABLE tracks ADD COLUMN duration_ms INTEGER;

-- One row per playback attempt through the Wavelengthz Player (the Spotify
-- Web Playback SDK path). The Free-tier iframe embed exposes no JS API at
-- all, so nothing there is observable and nothing there is recorded --
-- meaning this table measures the SDK population only, which is worth
-- remembering before reading any ratio off it.
--
-- The point is the ratio: rows total = plays started, rows with
-- reached_threshold_at set = plays that ran long enough for Spotify to count
-- the stream and pay out. Right now that number is completely invisible, and
-- a swipe-oriented app has an obvious structural reason to suspect it's bad
-- (tapping through five songs in twenty seconds counts zero of them).
--
-- This records what OUR player observed. It is emphatically not Spotify's own
-- royalty accounting, which we can neither see nor influence -- it's a proxy,
-- useful for spotting whether a change (starting at the hook, radio-style
-- continuation) actually moved listening behavior.
CREATE TABLE track_plays (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id),
  -- The internal catalog id when the track is cataloged. Deliberately no FK,
  -- matching music_swipes.item_id's precedent: a deck anthem comes straight
  -- from a user's cached Spotify top-tracks and has no `tracks` row at all,
  -- and an unplayable-to-record play is worse than an unreferenced id.
  track_id             TEXT,
  -- Always present -- the stable identifier across both cataloged and
  -- non-cataloged plays, and the only one that lines up with Spotify.
  spotify_track_id     TEXT NOT NULL,
  -- Where playback was told to start (the hook offset), so a later analysis
  -- can tell hook-started plays from 0:00 ones without guessing.
  start_position_ms    INTEGER NOT NULL DEFAULT 0,
  -- Set once accumulated playing time crosses the threshold. NULL means this
  -- play was abandoned before that -- which is exactly the signal wanted.
  reached_threshold_at INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX idx_track_plays_user ON track_plays(user_id, created_at);
-- Supports "what fraction of plays crossed the threshold", the whole reason
-- this table exists.
CREATE INDEX idx_track_plays_threshold ON track_plays(reached_threshold_at);
