-- migrations/0005_artist_catalog_growth.sql
-- Migration number: 0005 	 2026-08-08T12:00:00.000Z

-- Persisted per-genre Spotify search pagination cursor for artist catalog
-- growth (src/lib/catalogGrowth.ts) -- replaces the old artistTopUp's
-- single-random-offset search, which never advanced and re-sampled the
-- same shallow window of each genre's results forever. `exhausted` is set
-- once a page comes back shorter than a full page (or the offset has
-- walked past Spotify's real max), so growth knows to move on instead of
-- re-querying a genre with nothing left to find.
CREATE TABLE genre_search_cursors (
  genre         TEXT PRIMARY KEY,
  search_offset INTEGER NOT NULL DEFAULT 0,
  exhausted     INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

-- One row per scheduled catalog-growth run (src/lib/catalogGrowth.ts) --
-- source of truth for the daily digest email and manual inspection
-- (wrangler d1 execute), independent of Cloudflare's own log retention.
CREATE TABLE catalog_growth_runs (
  id             TEXT PRIMARY KEY,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  genres_tried   TEXT NOT NULL DEFAULT '[]',
  inserted_count INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     INTEGER NOT NULL
);
