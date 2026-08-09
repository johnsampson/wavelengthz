-- Migration number: 0009 	 2026-08-09T14:30:00.000Z

-- Bridges an artist's Spotify id to MusicBrainz, and marks whether genre
-- enrichment has been attempted at all -- distinct from "attempted but no
-- confident match found", which also sets genre_enriched_at but leaves mbid
-- NULL. Without that distinction a "no match" artist would get re-queried
-- against MusicBrainz's rate-limited API on every future enrichment run.
ALTER TABLE artists ADD COLUMN mbid TEXT;
ALTER TABLE artists ADD COLUMN genre_enriched_at INTEGER;

-- MusicBrainz genres arrive as community-tagged objects (name + a vote
-- count + MusicBrainz's own genre id), richer than the flat name-only list
-- Spotify provides. Their names still get unioned into artists.genres for
-- today's matching/scoring code to use immediately, but the full objects are
-- kept here too so that richer shape isn't thrown away before anything
-- exists yet to use it.
CREATE TABLE artist_musicbrainz_genres (
  artist_id TEXT NOT NULL REFERENCES artists(id),
  mb_genre_id TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artist_id, mb_genre_id)
);
