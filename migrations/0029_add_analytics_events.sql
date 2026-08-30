-- Issue #161 (part of the 250K-users strategy discussion): Spotify's own
-- Extended Quota Mode application verifies the 250K monthly-active-users
-- requirement via an export from *your own* analytics tool, not from
-- Spotify's API telemetry of calls this app makes -- confirmed against
-- Spotify's developer community docs. Nothing in this codebase records
-- any first-party usage event today, so there is no artifact this app
-- could actually produce if/when that application happens, regardless of
-- how many real people use it. This is deliberately minimal: enough to
-- derive a dated, exportable "distinct active users in the trailing N
-- days" count, not a general-purpose analytics platform.
--
-- Follows the migrations/0011-on schema conventions: its own id, plural
-- snake_case table name, created_at/updated_at on every table even though
-- an event row is never updated in practice (append-only log) -- no
-- carve-out for that in the convention, so none taken here.
CREATE TABLE analytics_events (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id), -- nullable: anonymous events (no session yet) still count toward reach
  event_type    TEXT NOT NULL,             -- e.g. 'session_start', 'song_play'
  metadata      TEXT,                      -- optional free-form JSON, shape varies per event_type
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Backs the MAU report's "distinct users active since <cutoff>" query --
-- filters on created_at first, so this index (not a user_id-first one)
-- matches that access pattern.
CREATE INDEX idx_analytics_events_created_user ON analytics_events(created_at, user_id);
-- Backs any later per-event-type breakdown (e.g. "how many song_play events
-- this week") without a full table scan.
CREATE INDEX idx_analytics_events_type_created ON analytics_events(event_type, created_at);
