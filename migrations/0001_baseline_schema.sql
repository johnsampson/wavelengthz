-- Migration number: 0001 	 2026-08-05T12:37:15.358Z

-- Core user record
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  spotify_id        TEXT UNIQUE NOT NULL,
  display_name      TEXT,
  bio               TEXT,
  date_of_birth     TEXT,             -- ISO date; source of truth for age gating
  age_verified_at   INTEGER,          -- null until 18+ confirmed at onboarding
  location_label    TEXT,             -- city/region, human readable
  lat               REAL,
  lng               REAL,
  location_updated_at INTEGER,         -- last time lat/lng actually changed; gates the 7-day move cooldown (null on first onboarding, not yet a "change")
  max_distance_km   INTEGER DEFAULT 80,  -- candidate search radius, user-adjustable
  gender            TEXT,              -- fixed set of options in the UI, not freeform-only
  seeking           TEXT,              -- fixed set of options in the UI, not freeform-only
  intent            TEXT,              -- "I'm interested in" -- fixed set of options in the UI, not freeform-only
  email             TEXT,
  spotify_avatar_url TEXT,           -- imported from Spotify's own profile photo; NEVER a match-facing photo (see user_photos)
  spotify_product   TEXT,           -- Spotify's own subscription tier ("premium" | "free" | "open"); refreshed on every login
  access_token      TEXT NOT NULL,    -- encrypted at rest
  refresh_token     TEXT NOT NULL,    -- encrypted at rest
  token_expires_at  INTEGER NOT NULL,
  onboarded_at      INTEGER,          -- null until profile setup complete
  deleted_at        INTEGER,          -- soft-delete marker; hard-delete job purges after grace period
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- People-mode profile photos, ordered
CREATE TABLE user_photos (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  r2_key      TEXT NOT NULL,
  position    INTEGER NOT NULL,     -- display order, 0 = primary
  created_at  INTEGER NOT NULL
);

-- Cached Spotify-derived music profile
CREATE TABLE music_profiles (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  top_artists     TEXT NOT NULL,   -- JSON [{artist_id, rank}, ...]
  top_tracks      TEXT NOT NULL,   -- JSON [{track_id, rank}, ...]
  top_genres      TEXT NOT NULL,   -- JSON ranked genre strings
  time_range      TEXT NOT NULL,   -- short_term | medium_term | long_term
  refreshed_at    INTEGER NOT NULL
);

-- The growing artist catalog (seeded + user-added)
CREATE TABLE artists (
  id              TEXT PRIMARY KEY,     -- Spotify artist ID when known
  name            TEXT NOT NULL,
  genres          TEXT NOT NULL,        -- JSON array of genre strings
  image_url       TEXT,
  popularity      INTEGER,              -- Spotify popularity 0-100, if known
  source          TEXT NOT NULL,        -- 'seed' | 'spotify_search' | 'user_added'
  added_by_user_id TEXT REFERENCES users(id),  -- null if seeded
  approved        INTEGER NOT NULL DEFAULT 1,  -- 0 = pending review
  created_at      INTEGER NOT NULL
);

-- Track catalog, same pattern as artists
CREATE TABLE tracks (
  id              TEXT PRIMARY KEY,     -- Spotify track ID when known
  name            TEXT NOT NULL,
  artist_id       TEXT NOT NULL REFERENCES artists(id),
  album_image_url TEXT,
  preview_url     TEXT,                 -- 30s preview, if Spotify provides one
  source          TEXT NOT NULL,
  added_by_user_id TEXT REFERENCES users(id),
  approved        INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

-- Session cookie -> user mapping
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- People-mode swipes (user on user)
CREATE TABLE people_swipes (
  id            TEXT PRIMARY KEY,
  swiper_id     TEXT NOT NULL REFERENCES users(id),
  target_id     TEXT NOT NULL REFERENCES users(id),
  direction     TEXT NOT NULL CHECK (direction IN ('left','right')),
  match_score   REAL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(swiper_id, target_id)
);

-- Music-mode swipes (user on artist OR track)
CREATE TABLE music_swipes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  item_type     TEXT NOT NULL CHECK (item_type IN ('artist','track')),
  item_id       TEXT NOT NULL,          -- artists.id or tracks.id
  direction     TEXT NOT NULL CHECK (direction IN ('left','right')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(user_id, item_type, item_id)
);

-- Mutual right-swipes in people mode
CREATE TABLE matches (
  id            TEXT PRIMARY KEY,
  user_a_id     TEXT NOT NULL REFERENCES users(id),
  user_b_id     TEXT NOT NULL REFERENCES users(id),
  unmatched_at  INTEGER,           -- null while active; set on unmatch, never hard-deleted
  unmatched_by  TEXT REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  UNIQUE(user_a_id, user_b_id)
);

-- Messages within an active match
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL REFERENCES matches(id),
  sender_id   TEXT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  read_at     INTEGER,
  created_at  INTEGER NOT NULL
);

-- One-directional blocks; a block always also ends any existing match
CREATE TABLE blocks (
  id          TEXT PRIMARY KEY,
  blocker_id  TEXT NOT NULL REFERENCES users(id),
  blocked_id  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  UNIQUE(blocker_id, blocked_id)
);

-- User reports for moderation review
CREATE TABLE reports (
  id            TEXT PRIMARY KEY,
  reporter_id   TEXT NOT NULL REFERENCES users(id),
  reported_id   TEXT NOT NULL REFERENCES users(id),
  reason        TEXT NOT NULL,      -- fixed set of reasons in the UI, not freeform-only
  details       TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','actioned','dismissed')),
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);

-- Transactional notifications only (matches, messages) -- see §10
CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),   -- recipient
  type          TEXT NOT NULL CHECK (type IN ('match','message')),
  related_id     TEXT NOT NULL,      -- matches.id or messages.id
  email_sent_at  INTEGER,            -- null until the email actually goes out
  read_at        INTEGER,            -- null until seen in-app
  created_at     INTEGER NOT NULL
);

-- Catalog-wide genre stats: how many artists/tracks in the WHOLE catalog
-- carry each genre. Auto-incremented whenever a new artist/track actually
-- gets inserted into the catalog (seed, catalog refresh, search-and-add, or
-- an artist-profile view upserting a not-yet-catalogued artist). A track's
-- genres are its artist's genres, since tracks don't carry their own.
CREATE TABLE genres (
  genre         TEXT PRIMARY KEY,
  artist_count  INTEGER NOT NULL DEFAULT 0,
  track_count   INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

-- Per-user genre affinity, built from right-swipes in music mode. Split into
-- artist_count/track_count (rather than one combined count) so "you both
-- like indie" can distinguish liking indie ARTISTS from liking indie TRACKS.
-- Incremented the first time a given item is swiped right, decremented if a
-- previously-right-swiped item is later changed to left. Feeds the "shared
-- genres" section of the match/profile pages.
CREATE TABLE user_genres (
  user_id       TEXT NOT NULL REFERENCES users(id),
  genre         TEXT NOT NULL,
  artist_count  INTEGER NOT NULL DEFAULT 0,
  track_count   INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, genre)
);

-- Small, user-created groups of people in the same area, for group music
-- discussion rather than 1:1 matching (src/routes/groups.ts). Formation is
-- user-created + browsable, not system-auto-clustered -- tuning real
-- auto-clustering needs usage data this app doesn't have yet.
CREATE TABLE groups (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  topic          TEXT,              -- optional, e.g. a genre or short description
  created_by     TEXT NOT NULL REFERENCES users(id),
  lat            REAL NOT NULL,
  lng            REAL NOT NULL,
  location_label TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id   TEXT NOT NULL REFERENCES groups(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- Same shape/moderation as 1:1 messages (src/lib/messageFilter.ts is reused
-- for both) -- kept in its own table rather than overloading `messages` so
-- group membership visibility can never leak into 1:1 matches or vice versa.
CREATE TABLE group_messages (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id),
  sender_id  TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_people_swipes_swiper ON people_swipes(swiper_id, created_at DESC);
CREATE INDEX idx_people_swipes_target ON people_swipes(target_id, direction, created_at DESC);
CREATE INDEX idx_music_swipes_user ON music_swipes(user_id, created_at DESC);
CREATE INDEX idx_artists_name ON artists(name);
CREATE INDEX idx_tracks_artist ON tracks(artist_id);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_messages_match ON messages(match_id, created_at);
CREATE INDEX idx_blocks_blocker ON blocks(blocker_id);
CREATE INDEX idx_reports_status ON reports(status, created_at);
CREATE INDEX idx_users_location ON users(lat, lng);
CREATE INDEX idx_user_genres_user ON user_genres(user_id, (artist_count + track_count) DESC);
CREATE INDEX idx_groups_location ON groups(lat, lng);
CREATE INDEX idx_group_members_user ON group_members(user_id);
CREATE INDEX idx_group_messages_group ON group_messages(group_id, created_at);

-- UNIQUE(user_a_id, user_b_id) only optimizes lookups where user_a_id is the
-- known side; GET /api/matches and account deletion both query
-- "user_a_id = ? OR user_b_id = ?" to find matches regardless of which slot
-- the caller landed in.
CREATE INDEX idx_matches_user_b ON matches(user_b_id);
-- Artist/track profile pages count total right-swipes by item, not by user --
-- every other music_swipes index leads with user_id and can't serve this.
CREATE INDEX idx_music_swipes_item ON music_swipes(item_type, item_id, direction);
-- Backs both "all photos for a user" and "primary photo (position=0) for a
-- user", the two access patterns used on every profile card/swipe deck render.
CREATE INDEX idx_user_photos_user ON user_photos(user_id, position);
-- Main swipe-deck query filters approved candidates ordered by recency.
CREATE INDEX idx_artists_approved ON artists(approved, created_at);
CREATE INDEX idx_tracks_approved ON tracks(approved, created_at);
-- Notification dedup check (related_id + type) and the delayed-match-email
-- cron, which runs every 5 minutes and would otherwise full-scan a
-- continuously growing table.
CREATE INDEX idx_notifications_related ON notifications(related_id, type);
CREATE INDEX idx_notifications_delayed_email ON notifications(type, email_sent_at, created_at);
-- Account-deletion/cleanup paths -- lower traffic than the above, but still
-- unindexed full scans today.
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_reports_reporter ON reports(reporter_id);
CREATE INDEX idx_reports_reported ON reports(reported_id);
CREATE INDEX idx_blocks_blocked ON blocks(blocked_id);
CREATE INDEX idx_users_deleted_at ON users(deleted_at);
