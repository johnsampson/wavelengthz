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
  max_distance_km   INTEGER DEFAULT 80,  -- candidate search radius, user-adjustable
  email             TEXT,
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
