-- Migration number: 0012 	 2026-08-10T01:30:00.000Z

-- A genre's corpus-wide "how common is this" density from MusicBrainz --
-- distinct from genres.artist_count/track_count, which count artists/tracks
-- in THIS APP'S OWN catalog, not across all of MusicBrainz. Nullable/no
-- default: mirrors artists.genre_enriched_at's "never attempted" vs
-- "attempted, here's the value" distinction, so a genre isn't re-queried
-- against MusicBrainz's rate-limited API every run once its density is
-- known (density changes slowly; no need to ever refresh eagerly).
ALTER TABLE genres ADD COLUMN musicbrainz_artist_count INTEGER;
ALTER TABLE genres ADD COLUMN musicbrainz_density_fetched_at INTEGER;
