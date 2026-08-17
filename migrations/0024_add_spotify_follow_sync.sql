-- Opt-in following of liked artists on Spotify. The second write destination,
-- after migrations/0023's playlist sync.
--
-- Deliberately its own tables and its own toggle rather than columns bolted
-- onto spotify_playlist_syncs. The two destinations differ in what they mean
-- and in how invasive they are -- a follow is OUTWARD-FACING (it appears on
-- the user's Spotify profile and feeds their Release Radar), where a private
-- playlist is not -- so consenting to one must never imply the other. Sharing
-- a row would make "sync is on" ambiguous at exactly the point where being
-- unambiguous matters.
--
-- Needs `user-follow-modify`, which like playlist-modify-private is NOT in
-- src/lib/spotify.ts's SCOPES and cannot be added to an already-issued token.
-- Enabling is therefore its own consent round trip
-- (/login/spotify?intent=follow), separate from both sign-in and playlist
-- sync.
--
-- Scoped to ARTIST right-swipes only, never track swipes. A deck right-swipe
-- on a track is a fast, high-volume gesture; following an artist is a public
-- statement. Cascading track likes into follows would fill someone's Spotify
-- profile with artists they never chose to be seen following.

CREATE TABLE spotify_follow_syncs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Same distinction as the playlist table: scope is *can*, this is *wants
  -- to*, and both are checked before any write.
  enabled INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id)
);

-- Ledger of artists already followed on this user's behalf. Exists for the
-- same reason migrations/0023's does: the follow list is the user's, they may
-- unfollow, and without a record every run would re-follow what they removed.
-- A row here means "we sent this once" and is never re-sent.
CREATE TABLE spotify_follow_sync_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Spotify's artist id, not the local artists.id -- the follow lives in
  -- Spotify and that is the identity that matters there.
  spotify_artist_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, spotify_artist_id)
);

CREATE INDEX idx_spotify_follow_sync_items_user ON spotify_follow_sync_items(user_id);
