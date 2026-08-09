-- Migration number: 0010 	 2026-08-09T16:00:00.000Z

-- Renames artist_musicbrainz_genres -> artist_genres and gives it its own
-- id, per the schema conventions in CLAUDE.md (Rails-style table naming,
-- every table gets its own id + created_at + updated_at) adopted starting
-- with this migration. SQLite/D1 can't ALTER a table's PRIMARY KEY in
-- place, so this is a rebuild: create the new shape, copy rows in
-- (generating a UUID per row -- same randomblob-based expression already
-- used in migrations/0002 for the artists/tracks id migration), drop the
-- old table, done. The (artist_id, mb_genre_id) pair moves from being the
-- primary key to a plain UNIQUE constraint -- src/lib/genreEnrichment.ts's
-- upsert still targets it via ON CONFLICT, unchanged.
CREATE TABLE artist_genres (
  id           TEXT PRIMARY KEY,
  artist_id    TEXT NOT NULL REFERENCES artists(id),
  mb_genre_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  count        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (artist_id, mb_genre_id)
);

INSERT INTO artist_genres (id, artist_id, mb_genre_id, name, count, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  artist_id, mb_genre_id, name, count, created_at, created_at
FROM artist_musicbrainz_genres;

DROP TABLE artist_musicbrainz_genres;
