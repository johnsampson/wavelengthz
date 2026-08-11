-- Migration number: 0016 	 2026-08-10T02:15:00.000Z

-- Tracks how many items in a genre a user has passed on (left-swiped),
-- symmetric to the existing artist_count/track_count (right-swipe/like
-- tracking) already on this table -- src/routes/musicSwipes.ts's
-- applyGenrePass mirrors applyGenreAffinity's transition-based
-- increment/decrement exactly. Used to trigger the "block this genre?"
-- prompt once a user's passes on a genre cross a threshold.
ALTER TABLE user_genres ADD COLUMN pass_count INTEGER NOT NULL DEFAULT 0;

-- A user's explicit choice to hide a genre from their swipe deck entirely,
-- separate from pass_count (a running tally) -- this is a one-time action,
-- not a count, so it gets its own table rather than another column here.
CREATE TABLE user_blocked_genres (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  genre      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, genre)
);
CREATE INDEX idx_user_blocked_genres_user ON user_blocked_genres(user_id);
