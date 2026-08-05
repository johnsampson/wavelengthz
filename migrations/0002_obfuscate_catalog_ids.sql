-- Migration number: 0002 	 2026-08-05T13:50:37.481Z

-- Obfuscate the Spotify artist/track IDs that were previously used directly
-- as artists.id/tracks.id, which leaked into every URL, API response, and
-- swipe/history row that touched them. Every other table already uses an
-- app-generated UUID as its id (see users.id vs users.spotify_id, the
-- existing precedent this follows) -- this brings artists/tracks in line:
-- spotify_id keeps the real Spotify ID for internal use (calling Spotify's
-- API, deduping re-imports of the same artist/track), while id becomes an
-- opaque UUID used everywhere else (URLs, music_swipes.item_id,
-- tracks.artist_id). Not declared NOT NULL -- SQLite's ALTER TABLE can't add
-- that retroactively without a full table rebuild -- but every insertion
-- path (src/lib/catalogUpsert.ts) always supplies it.
--
-- defer_foreign_keys: repointing tracks.artist_id/music_swipes.item_id to
-- an artist's new UUID has to happen while artists.id is STILL the old
-- Spotify id (that's the join key); swapping artists.id itself happens
-- after. Immediate FK enforcement would reject that intermediate state even
-- though the whole migration reconciles by its end -- deferring checks to
-- commit is exactly what this pragma is for.
PRAGMA defer_foreign_keys = ON;

-- === artists ===
ALTER TABLE artists ADD COLUMN spotify_id TEXT;
UPDATE artists SET spotify_id = id;

ALTER TABLE artists ADD COLUMN new_id TEXT;
UPDATE artists SET new_id = (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
);

-- Repoint every reference to artists.id to the new UUID BEFORE artists.id
-- itself changes -- both lookups below still join on the OLD (Spotify) id.
UPDATE tracks SET artist_id = (SELECT new_id FROM artists WHERE artists.id = tracks.artist_id);
UPDATE music_swipes SET item_id = (SELECT new_id FROM artists WHERE artists.id = music_swipes.item_id) WHERE item_type = 'artist';

UPDATE artists SET id = new_id;
ALTER TABLE artists DROP COLUMN new_id;
CREATE UNIQUE INDEX idx_artists_spotify_id ON artists(spotify_id);

-- === tracks ===
ALTER TABLE tracks ADD COLUMN spotify_id TEXT;
UPDATE tracks SET spotify_id = id;

ALTER TABLE tracks ADD COLUMN new_id TEXT;
UPDATE tracks SET new_id = (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
);

UPDATE music_swipes SET item_id = (SELECT new_id FROM tracks WHERE tracks.id = music_swipes.item_id) WHERE item_type = 'track';

UPDATE tracks SET id = new_id;
ALTER TABLE tracks DROP COLUMN new_id;
CREATE UNIQUE INDEX idx_tracks_spotify_id ON tracks(spotify_id);
