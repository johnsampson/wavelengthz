-- Migration number: 0011 	 2026-08-09T18:00:00.000Z

-- Brings the rest of the schema in line with the conventions in CLAUDE.md
-- (every table gets its own id, created_at, and updated_at), following the
-- artist_genres precedent set in migrations/0010. Two shapes of change:
--
-- (A) Four tables keyed by a natural/composite key instead of their own id
--     (music_profiles, genres, user_genres, group_members) get rebuilt --
--     SQLite/D1 can't change a PRIMARY KEY via plain ALTER TABLE, so each
--     is: rename old, create new shape, copy rows across generating a UUID
--     per row (same randomblob expression as migrations/0002 and 0010),
--     drop old. None of these four tables are referenced by any other
--     table's foreign key, so no PRAGMA defer_foreign_keys is needed here
--     (unlike migrations/0002's artists/tracks rebuild, which was).
--
-- (B) The other eleven tables already have their own id -- they just get
--     `updated_at ADD COLUMN`, backfilled from created_at. SQLite requires
--     a non-null DEFAULT to add a NOT NULL column to a table with existing
--     rows; the immediately-following UPDATE corrects every existing row's
--     value in the same migration, so the DEFAULT 0 is never actually
--     visible to application code.

-- === (A) music_profiles ===
ALTER TABLE music_profiles RENAME TO music_profiles_old;

CREATE TABLE music_profiles (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  top_artists   TEXT NOT NULL,
  top_tracks    TEXT NOT NULL,
  top_genres    TEXT NOT NULL,
  time_range    TEXT NOT NULL,
  refreshed_at  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(user_id)
);

-- No better historical created_at exists than the row's own refreshed_at
-- (this table has never recorded when a profile was first created, only
-- when it was last refreshed) -- used for both created_at and updated_at.
INSERT INTO music_profiles (id, user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  user_id, top_artists, top_tracks, top_genres, time_range, refreshed_at, refreshed_at, refreshed_at
FROM music_profiles_old;

DROP TABLE music_profiles_old;

-- === (A) genres ===
ALTER TABLE genres RENAME TO genres_old;

CREATE TABLE genres (
  id            TEXT PRIMARY KEY,
  genre         TEXT NOT NULL,
  artist_count  INTEGER NOT NULL DEFAULT 0,
  track_count   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(genre)
);

-- No historical created_at exists for this table either -- its own
-- updated_at is the best available stand-in.
INSERT INTO genres (id, genre, artist_count, track_count, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  genre, artist_count, track_count, updated_at, updated_at
FROM genres_old;

DROP TABLE genres_old;

-- === (A) user_genres ===
ALTER TABLE user_genres RENAME TO user_genres_old;

CREATE TABLE user_genres (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  genre         TEXT NOT NULL,
  artist_count  INTEGER NOT NULL DEFAULT 0,
  track_count   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(user_id, genre)
);

INSERT INTO user_genres (id, user_id, genre, artist_count, track_count, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  user_id, genre, artist_count, track_count, updated_at, updated_at
FROM user_genres_old;

DROP TABLE user_genres_old;

-- Dropped with user_genres_old -- recreate against the new table.
CREATE INDEX idx_user_genres_user ON user_genres(user_id, (artist_count + track_count) DESC);

-- === (A) group_members ===
ALTER TABLE group_members RENAME TO group_members_old;

CREATE TABLE group_members (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  joined_at  INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, user_id)
);

-- joined_at IS this table's creation timestamp -- kept as its own column
-- (application code reads it as "joined_at" specifically) alongside the
-- new generic created_at/updated_at, rather than replaced by them.
INSERT INTO group_members (id, group_id, user_id, joined_at, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  group_id, user_id, joined_at, joined_at, joined_at
FROM group_members_old;

DROP TABLE group_members_old;

-- Dropped with group_members_old -- recreate against the new table.
CREATE INDEX idx_group_members_user ON group_members(user_id);

-- === (B) plain ADD COLUMN + backfill, already-id'd tables ===
ALTER TABLE user_photos ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE user_photos SET updated_at = created_at;

ALTER TABLE artists ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE artists SET updated_at = created_at;

ALTER TABLE tracks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE tracks SET updated_at = created_at;

ALTER TABLE sessions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET updated_at = created_at;

ALTER TABLE matches ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE matches SET updated_at = created_at;

ALTER TABLE messages ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET updated_at = created_at;

ALTER TABLE blocks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE blocks SET updated_at = created_at;

ALTER TABLE reports ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE reports SET updated_at = created_at;

ALTER TABLE notifications ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE notifications SET updated_at = created_at;

ALTER TABLE groups ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE groups SET updated_at = created_at;

ALTER TABLE group_messages ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE group_messages SET updated_at = created_at;
