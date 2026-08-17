-- Opt-in one-way export of liked tracks into a Spotify playlist the app owns.
--
-- Deliberately separate from sign-in. Writing to someone's Spotify account
-- needs `playlist-modify-private`, which is NOT in src/lib/spotify.ts's
-- SCOPES and cannot be added to an already-issued token -- a refresh can only
-- ever re-issue the scopes the original consent granted (see the comment on
-- SCOPES, and src/lib/tokens.ts's COALESCE on granted_scope). So enabling
-- this requires a full second /login round trip no matter how it's designed;
-- making that an explicit, explained opt-in is strictly better than an
-- unexplained forced re-login, and keeps the first-run consent screen from
-- asking a stranger for write access before they've seen any value.

CREATE TABLE spotify_playlist_syncs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Distinct from "does granted_scope contain playlist-modify-private".
  -- Scope is *can*, this is *wants to*: someone can grant the scope and
  -- still turn sync off, and turning it off must not require revoking
  -- anything at Spotify's end. Both are checked before any write.
  enabled INTEGER NOT NULL DEFAULT 0,
  -- Spotify's own playlist id, NULL until the first sync actually creates
  -- one. Created lazily rather than at enable time so flipping the toggle
  -- on and back off never leaves a stray empty playlist in someone's
  -- account.
  playlist_id TEXT,
  playlist_url TEXT,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id)
);

-- The ledger of what this app has already pushed. Not a queue: what's
-- *pending* is derived by left-joining right-swiped tracks against this
-- table (see src/lib/playlistSync.ts's PENDING_TRACKS_SQL), the same
-- "derive it, don't store a second copy" approach migrations/0021 took for
-- thread playlists.
--
-- The reason this table has to exist at all is that the playlist is not a
-- mirror -- it's the user's, and they may delete tracks out of it. Without a
-- record of what was already sent, every sync would re-add whatever they
-- removed, which is the app fighting the user over their own playlist. A row
-- here means "we sent this once"; it is never re-sent, even if it's no
-- longer in the playlist.
CREATE TABLE spotify_playlist_sync_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Spotify's track id, not the local tracks.id: the playlist lives in
  -- Spotify and this is the identity that matters there. Also survives a
  -- local catalog row being rebuilt or re-fetched under a new internal id.
  spotify_track_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, spotify_track_id)
);

CREATE INDEX idx_spotify_playlist_sync_items_user ON spotify_playlist_sync_items(user_id);
