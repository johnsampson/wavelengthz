-- Migration number: 0008 	 2026-08-09T02:37:54.000Z

-- The actual OAuth scopes granted on the currently-stored token, space-
-- separated exactly as Spotify's token response returns them. Needed to
-- gate the Wavelengthz Player (Spotify Web Playback SDK, src/routes/player.ts)
-- on the `streaming` scope without guessing: a token issued before that
-- scope was added to src/lib/spotify.ts's SCOPES simply won't have it, and
-- only a fresh /login (full re-consent) can grant it -- refreshing an
-- existing token cannot silently add scopes the user never approved. Null
-- for every row until its next login or refresh populates it.
ALTER TABLE music_source_tokens ADD COLUMN granted_scope TEXT;
