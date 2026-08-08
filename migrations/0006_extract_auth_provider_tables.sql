-- Migration number: 0006 	 2026-08-08T18:00:00.000Z

-- Extracts Spotify token/profile storage off `users` into two general-
-- purpose tables, so a second identity provider (Google, in a follow-up)
-- can be added without special-casing `users`. auth_identities answers
-- "how does this user log in"; music_source_tokens answers "where do we
-- pull this user's music-taste data from".
--
-- NOTE on spotify_id: SQLite cannot drop a UNIQUE column via ALTER TABLE
-- (confirmed empirically -- "cannot drop UNIQUE column" SQLITE_ERROR), and
-- the standard SQLite workaround (rebuild the table under a temp name) is
-- blocked in D1 specifically: D1 enforces foreign keys unconditionally
-- (verified empirically here and previously in src/lib/accountDeletion.ts's
-- module comment) and refuses `DROP TABLE users` while any of the ~14
-- other tables with a live `REFERENCES users(id)` foreign key still exist --
-- even under `PRAGMA defer_foreign_keys = ON`. Rebuilding every referencing
-- table too, just to relax one column's constraint, is a disproportionate,
-- high-risk operation for this refactor. `users.spotify_id` therefore stays
-- in place (still UNIQUE NOT NULL) as a legacy column the application no
-- longer reads -- auth_identities is the authoritative source going
-- forward. Solving spotify_id's constraint for a Spotify-less (e.g.
-- Google-only) user is deferred to the Google Sign-On follow-up, once it's
-- actually needed.
--
-- The other five columns (access_token, refresh_token, token_expires_at,
-- spotify_avatar_url, spotify_product) have no UNIQUE constraint and no
-- other table references them, so a plain DROP COLUMN works -- confirmed
-- empirically.
CREATE TABLE auth_identities (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  provider     TEXT NOT NULL,
  provider_id  TEXT NOT NULL,
  email        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(provider, provider_id)
);

CREATE TABLE music_source_tokens (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  provider          TEXT NOT NULL,
  provider_user_id  TEXT NOT NULL,
  access_token      TEXT NOT NULL,
  refresh_token     TEXT NOT NULL,
  token_expires_at  INTEGER NOT NULL,
  avatar_url        TEXT,
  product_tier      TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(user_id, provider),
  UNIQUE(provider, provider_user_id)
);

INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
SELECT lower(hex(randomblob(16))), id, 'spotify', spotify_id, email, created_at, updated_at FROM users;

INSERT INTO music_source_tokens (id, user_id, provider, provider_user_id, access_token, refresh_token, token_expires_at, avatar_url, product_tier, created_at, updated_at)
SELECT lower(hex(randomblob(16))), id, 'spotify', spotify_id, access_token, refresh_token, token_expires_at, spotify_avatar_url, spotify_product, created_at, updated_at FROM users;

ALTER TABLE users DROP COLUMN access_token;
ALTER TABLE users DROP COLUMN refresh_token;
ALTER TABLE users DROP COLUMN token_expires_at;
ALTER TABLE users DROP COLUMN spotify_avatar_url;
ALTER TABLE users DROP COLUMN spotify_product;
