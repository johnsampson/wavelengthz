-- Migration number: 0019 	 2026-08-11T00:00:00.000Z

-- Adds 'skip' as a third music_swipes.direction value, alongside the
-- existing 'left' (pass) and 'right' (like) -- for an artist the user
-- doesn't recognize and isn't ready to judge either way (src/routes/index.html's
-- new skip button, next to Pass/Like). Skip still removes the artist from
-- the immediate candidate pool (same NOT IN (...) exclusion every swiped
-- item already gets in src/routes/musicSwipes.ts's candidates query) so the
-- deck keeps moving, but the user can come back to it later via History's
-- existing "Change" toggle -- skip is a deferred decision, not a verdict,
-- so it deliberately reuses that mechanism rather than inventing a second
-- one.
--
-- SQLite/D1 can't ALTER a CHECK constraint in place, so this is the same
-- rebuild pattern as migrations/0010: create the new shape, copy rows in
-- unchanged (direction values already in the table are all 'left'/'right',
-- both still valid under the wider CHECK), drop the old table, rename the
-- new one into place, then recreate the two indexes music_swipes already
-- had.
CREATE TABLE music_swipes_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  item_type     TEXT NOT NULL CHECK (item_type IN ('artist','track')),
  item_id       TEXT NOT NULL,          -- artists.id or tracks.id
  direction     TEXT NOT NULL CHECK (direction IN ('left','right','skip')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(user_id, item_type, item_id)
);

INSERT INTO music_swipes_new (id, user_id, item_type, item_id, direction, created_at, updated_at)
SELECT id, user_id, item_type, item_id, direction, created_at, updated_at FROM music_swipes;

DROP TABLE music_swipes;

ALTER TABLE music_swipes_new RENAME TO music_swipes;

CREATE INDEX idx_music_swipes_user ON music_swipes(user_id, created_at DESC);
CREATE INDEX idx_music_swipes_item ON music_swipes(item_type, item_id, direction);
