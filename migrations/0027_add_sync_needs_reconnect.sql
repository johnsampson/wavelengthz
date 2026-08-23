-- Persist WHY playlist sync / following got turned off, not just that it
-- did. src/lib/playlistSync.ts's and followSync.ts's auto-disable-on-
-- revocation paths (isSpotifyAuthFailure -- Spotify revoked access from
-- their own side) previously called the exact same setSyncEnabled/
-- setFollowSyncEnabled an explicit user toggle-off calls, so once the
-- moment's toast ("Spotify revoked access... turn it back on to
-- reconnect") disappeared, a later page load showed an ordinary-looking
-- disabled toggle with no indication Spotify had revoked access rather
-- than the user choosing to turn it off themselves (issue #127).
ALTER TABLE spotify_playlist_syncs ADD COLUMN needs_reconnect INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spotify_follow_syncs ADD COLUMN needs_reconnect INTEGER NOT NULL DEFAULT 0;
