-- issue #127: "Start a group from a song." A group can optionally be seeded
-- with a track at creation time -- nullable, since every existing group (and
-- most new ones) has none. References tracks(id), the same internal catalog
-- id group_messages.track_id already points at (see migrations/0021), so
-- rendering it reuses the exact same loadSharedTracks() lookup as any other
-- shared track.
ALTER TABLE groups ADD COLUMN seed_track_id TEXT REFERENCES tracks(id);
