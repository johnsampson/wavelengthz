export const schema = `
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  spotify_id        TEXT UNIQUE NOT NULL,
  display_name      TEXT,
  bio               TEXT,
  date_of_birth     TEXT,
  age_verified_at   INTEGER,
  location_label    TEXT,
  lat               REAL,
  lng               REAL,
  max_distance_km   INTEGER DEFAULT 80,
  email             TEXT,
  access_token      TEXT NOT NULL,
  refresh_token     TEXT NOT NULL,
  token_expires_at  INTEGER NOT NULL,
  onboarded_at      INTEGER,
  deleted_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE user_photos (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  r2_key      TEXT NOT NULL,
  position    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE music_profiles (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  top_artists     TEXT NOT NULL,
  top_tracks      TEXT NOT NULL,
  top_genres      TEXT NOT NULL,
  time_range      TEXT NOT NULL,
  refreshed_at    INTEGER NOT NULL
);

CREATE TABLE artists (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  genres          TEXT NOT NULL,
  image_url       TEXT,
  popularity      INTEGER,
  source          TEXT NOT NULL,
  added_by_user_id TEXT REFERENCES users(id),
  approved        INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

CREATE TABLE tracks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  artist_id       TEXT NOT NULL REFERENCES artists(id),
  album_image_url TEXT,
  preview_url     TEXT,
  source          TEXT NOT NULL,
  added_by_user_id TEXT REFERENCES users(id),
  approved        INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

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

CREATE TABLE music_swipes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  item_type     TEXT NOT NULL CHECK (item_type IN ('artist','track')),
  item_id       TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('left','right')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(user_id, item_type, item_id)
);

CREATE TABLE matches (
  id            TEXT PRIMARY KEY,
  user_a_id     TEXT NOT NULL REFERENCES users(id),
  user_b_id     TEXT NOT NULL REFERENCES users(id),
  unmatched_at  INTEGER,
  unmatched_by  TEXT REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  UNIQUE(user_a_id, user_b_id)
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL REFERENCES matches(id),
  sender_id   TEXT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  read_at     INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE blocks (
  id          TEXT PRIMARY KEY,
  blocker_id  TEXT NOT NULL REFERENCES users(id),
  blocked_id  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  UNIQUE(blocker_id, blocked_id)
);

CREATE TABLE reports (
  id            TEXT PRIMARY KEY,
  reporter_id   TEXT NOT NULL REFERENCES users(id),
  reported_id   TEXT NOT NULL REFERENCES users(id),
  reason        TEXT NOT NULL,
  details       TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','actioned','dismissed')),
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);

CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  type          TEXT NOT NULL CHECK (type IN ('match','message')),
  related_id     TEXT NOT NULL,
  email_sent_at  INTEGER,
  read_at        INTEGER,
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
`;
