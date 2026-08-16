-- Track sharing as a first-class message type, in both 1:1 match threads and
-- group threads.
--
-- track_id references the shared catalog (tracks.id, the internal UUID -- not
-- the Spotify id, same convention as music_swipes.item_id) rather than
-- stuffing a URL into `body`: isValidMessageBody's charset
-- (src/lib/messageFilter.ts) deliberately blocks colons and slashes to keep
-- links out of messages, and that restriction is worth keeping.
--
-- `body` stays NOT NULL and carries an optional caption alongside the track
-- ("this one's you") -- empty string when there's none. SQLite can't drop a
-- NOT NULL constraint via ALTER TABLE anyway, and a caption is most of what
-- makes sending a song feel personal, so this is the shape we'd have chosen
-- regardless. isValidMessageBody gains a companion (isValidTrackMessage) that
-- allows an empty body precisely when a track_id is present.
--
-- Nullable with a NULL default, which is what SQLite requires for ADD COLUMN
-- with a REFERENCES clause. Every existing row is a plain text message and
-- stays exactly that.
--
-- Deliberately NO separate playlist table: a match's (or group's) shared
-- playlist is derived by querying non-recalled track messages in order. A
-- second copy of that list would drift the moment a message is recalled
-- (15s window, src/lib/messageRecall.ts), a match is unmatched, or an account
-- is deleted -- all of which already cascade correctly through messages.
ALTER TABLE messages ADD COLUMN track_id TEXT REFERENCES tracks(id);
ALTER TABLE group_messages ADD COLUMN track_id TEXT REFERENCES tracks(id);

-- Powers the derived-playlist query (every non-recalled track message in a
-- thread, in order) without scanning the whole thread.
CREATE INDEX idx_messages_match_track ON messages(match_id, track_id);
CREATE INDEX idx_group_messages_group_track ON group_messages(group_id, track_id);
