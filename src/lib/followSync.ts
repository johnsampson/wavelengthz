import { FOLLOW_MAX_IDS, FOLLOW_SYNC_SCOPE, followArtists, isSpotifyAuthFailure } from './spotify';
import { getValidAccessToken } from './tokens';
import type { UserRow } from './session';

// Mirrors SYNC_MAX_TRACKS_PER_RUN's reasoning in playlistSync.ts, scaled to
// this endpoint's smaller batch size: at FOLLOW_MAX_IDS per call this is 3
// calls per run. The remainder is picked up next run rather than lost, since
// pending work is derived rather than queued.
export const SYNC_MAX_ARTISTS_PER_RUN = 150;

// Right-swiped artists that carry a Spotify id and haven't been followed yet.
//
// Derived, never stored -- same approach as playlistSync's PENDING_TRACKS_SQL,
// so there is no queue table to fall out of step with the swipes it mirrors,
// and a first-time backfill is the same code path as ongoing sync.
//
// item_type = 'artist' ONLY. Track right-swipes cascade to an artist-level
// like in src/routes/musicSwipes.ts (likeArtistForTrack), so an artist a user
// reached via liking a song still lands here -- but through that deliberate,
// already-existing cascade rather than by this query treating a track swipe
// as a follow.
const PENDING_ARTISTS_SQL = `
  SELECT a.spotify_id as spotify_id
  FROM music_swipes ms
  JOIN artists a ON a.id = ms.item_id
  WHERE ms.user_id = ?
    AND ms.item_type = 'artist'
    AND ms.direction = 'right'
    AND a.spotify_id IS NOT NULL AND a.spotify_id != ''
    AND NOT EXISTS (
      SELECT 1 FROM spotify_follow_sync_items i
      WHERE i.user_id = ms.user_id AND i.spotify_artist_id = a.spotify_id
    )
  ORDER BY ms.created_at ASC
`;

export interface FollowSyncRow {
  id: string;
  enabled: number;
  last_synced_at: number | null;
  needs_reconnect: number;
}

export interface FollowSyncStatus {
  enabled: boolean;
  /** Whether the account actually consented to FOLLOW_SYNC_SCOPE. */
  connected: boolean;
  lastSyncedAt: number | null;
  pendingCount: number;
  followedCount: number;
  /**
   * True when following is off because Spotify revoked access, not because
   * the user chose to turn it off -- see playlistSync.ts's identical field
   * for the full reasoning (migrations/0027).
   */
  needsReconnect: boolean;
}

export type FollowSkipReason = 'disabled' | 'scope_missing' | 'no_spotify';

export interface FollowSyncResult {
  followed: number;
  skipped?: FollowSkipReason;
  needsReconnect?: boolean;
  hasMore?: boolean;
}

export function hasFollowScope(grantedScope: string | null | undefined): boolean {
  return grantedScope?.split(' ').includes(FOLLOW_SYNC_SCOPE) ?? false;
}

export async function getFollowSyncRow(db: D1Database, userId: string): Promise<FollowSyncRow | null> {
  return db
    .prepare('SELECT id, enabled, last_synced_at, needs_reconnect FROM spotify_follow_syncs WHERE user_id = ?')
    .bind(userId)
    .first<FollowSyncRow>();
}

async function getSpotifyAccount(db: D1Database, userId: string): Promise<{ granted_scope: string | null } | null> {
  return db
    .prepare(`SELECT granted_scope FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`)
    .bind(userId)
    .first<{ granted_scope: string | null }>();
}

export async function countPendingArtists(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) as c FROM (${PENDING_ARTISTS_SQL})`).bind(userId).first<{ c: number }>();
  return row?.c ?? 0;
}

/** Everything the settings UI needs, entirely from D1 -- no Spotify call. */
export async function getFollowSyncStatus(db: D1Database, userId: string): Promise<FollowSyncStatus> {
  const [row, account, pendingCount, followedRow] = await Promise.all([
    getFollowSyncRow(db, userId),
    getSpotifyAccount(db, userId),
    countPendingArtists(db, userId),
    db
      .prepare('SELECT COUNT(*) as c FROM spotify_follow_sync_items WHERE user_id = ?')
      .bind(userId)
      .first<{ c: number }>(),
  ]);

  return {
    enabled: row?.enabled === 1,
    connected: hasFollowScope(account?.granted_scope),
    lastSyncedAt: row?.last_synced_at ?? null,
    pendingCount,
    followedCount: followedRow?.c ?? 0,
    needsReconnect: row?.needs_reconnect === 1,
  };
}

/**
 * `needsReconnect` defaults to false -- see playlistSync.ts's setSyncEnabled
 * for the identical reasoning: every ordinary caller is a real, current,
 * intentional state change that supersedes whatever reason following was
 * previously off for; only the auth-failure paths below pass true.
 */
export async function setFollowSyncEnabled(db: D1Database, userId: string, enabled: boolean, now: number, needsReconnect = false): Promise<void> {
  await db
    .prepare(
      `INSERT INTO spotify_follow_syncs (id, user_id, enabled, needs_reconnect, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, needs_reconnect = excluded.needs_reconnect, updated_at = excluded.updated_at`
    )
    .bind(crypto.randomUUID(), userId, enabled ? 1 : 0, needsReconnect ? 1 : 0, now, now)
    .run();
}

/**
 * Follow the artists this user has liked but doesn't yet follow on Spotify.
 *
 * The single write path, shared by the "Follow now" button and the cron.
 * Makes no Spotify call unless something is genuinely pending, and never runs
 * without both an explicit enabled flag and a real FOLLOW_SYNC_SCOPE grant.
 *
 * Note there is no equivalent of playlistSync's resolvePlaylist here: a
 * follow has no container to create or verify, so this is strictly simpler --
 * check, batch, write, record.
 */
export async function runFollowSync(env: Env, user: UserRow, now: number = Date.now()): Promise<FollowSyncResult> {
  const db = env.DB;
  const row = await getFollowSyncRow(db, user.id);
  if (row?.enabled !== 1) return { followed: 0, skipped: 'disabled' };

  const account = await getSpotifyAccount(db, user.id);
  if (!account) return { followed: 0, skipped: 'no_spotify' };
  if (!hasFollowScope(account.granted_scope)) return { followed: 0, skipped: 'scope_missing' };

  // Read one past the cap purely to report hasMore honestly.
  const pending = await db
    .prepare(`${PENDING_ARTISTS_SQL} LIMIT ?`)
    .bind(user.id, SYNC_MAX_ARTISTS_PER_RUN + 1)
    .all<{ spotify_id: string }>();

  const hasMore = pending.results.length > SYNC_MAX_ARTISTS_PER_RUN;
  const artistIds = pending.results.slice(0, SYNC_MAX_ARTISTS_PER_RUN).map((r) => r.spotify_id);

  if (artistIds.length === 0) {
    await db
      .prepare('UPDATE spotify_follow_syncs SET last_synced_at = ?, updated_at = ? WHERE user_id = ?')
      .bind(now, now, user.id)
      .run();
    return { followed: 0 };
  }

  try {
    const token = await getValidAccessToken(user, env, db);

    let followed = 0;
    for (let i = 0; i < artistIds.length; i += FOLLOW_MAX_IDS) {
      const chunk = artistIds.slice(i, i + FOLLOW_MAX_IDS);
      await followArtists(token, chunk);

      // Ledger written per chunk, immediately after that chunk lands -- so a
      // later failure doesn't cause the retry to re-follow what already went
      // out. Same discipline as playlistSync.
      await db.batch(
        chunk.map((spotifyArtistId) =>
          db
            .prepare(
              `INSERT INTO spotify_follow_sync_items (id, user_id, spotify_artist_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(user_id, spotify_artist_id) DO NOTHING`
            )
            .bind(crypto.randomUUID(), user.id, spotifyArtistId, now, now)
        )
      );
      followed += chunk.length;
    }

    await db
      .prepare('UPDATE spotify_follow_syncs SET last_synced_at = ?, updated_at = ? WHERE user_id = ?')
      .bind(now, now, user.id)
      .run();

    return { followed, hasMore };
  } catch (error) {
    // Access revoked at Spotify's end. Turn sync off so the cron stops
    // retrying a grant that no longer exists, and report it so the UI can
    // offer reconnect rather than a generic failure.
    if (isSpotifyAuthFailure(error)) {
      await setFollowSyncEnabled(db, user.id, false, now, true);
      return { followed: 0, needsReconnect: true };
    }
    throw error;
  }
}

/**
 * Follow a single artist immediately, called from the swipe endpoints
 * (src/routes/musicSwipes.ts) right when a right-swipe lands on an artist --
 * directly, or via the track-like-cascades-to-artist-like path -- so
 * following actually happens "when you like them here", matching
 * connections.html's own copy, instead of only within the next hourly
 * runScheduledFollowSync tick or a manual "Follow now" tap. Both of those
 * remain as the safety net for whatever this misses (a failed call here, a
 * user who enables sync after already having liked artists, a like that
 * came in before this shipped) -- this is additive, not a replacement.
 *
 * Deliberately narrow, unlike runFollowSync: no batching, no hasMore, no
 * last_synced_at bump (that timestamp means "the sweep ran", not "a follow
 * happened"). Callers must never await this inline in a request handler --
 * wrap it in ctx.waitUntil so a slow or failed Spotify call never delays or
 * breaks the swipe itself; any failure here silently falls back to the
 * hourly sweep, since no ledger row gets written on failure.
 */
export async function syncFollowForArtist(env: Env, user: UserRow, spotifyArtistId: string, now: number = Date.now()): Promise<void> {
  if (!spotifyArtistId) return;
  const db = env.DB;

  const row = await getFollowSyncRow(db, user.id);
  if (row?.enabled !== 1) return;

  const account = await getSpotifyAccount(db, user.id);
  if (!account || !hasFollowScope(account.granted_scope)) return;

  // DB-first: skip the Spotify call entirely if this artist is already
  // recorded as followed (an earlier like, or a prior sweep already got it).
  const already = await db
    .prepare('SELECT 1 FROM spotify_follow_sync_items WHERE user_id = ? AND spotify_artist_id = ?')
    .bind(user.id, spotifyArtistId)
    .first();
  if (already) return;

  try {
    const token = await getValidAccessToken(user, env, db);
    await followArtists(token, [spotifyArtistId]);
    await db
      .prepare(
        `INSERT INTO spotify_follow_sync_items (id, user_id, spotify_artist_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, spotify_artist_id) DO NOTHING`
      )
      .bind(crypto.randomUUID(), user.id, spotifyArtistId, now, now)
      .run();
  } catch (error) {
    if (isSpotifyAuthFailure(error)) {
      await setFollowSyncEnabled(db, user.id, false, now, true);
      return;
    }
    // Rate limit, transient network error, etc. -- swallowed here rather
    // than surfaced to the swipe response. No ledger row was written, so
    // this artist stays pending and the next hourly sweep picks it up.
    console.error('syncFollowForArtist failed', error);
  }
}

/**
 * Cron entry point. Sequential and per-user isolated, for the same reason
 * runScheduledPlaylistSync is: these are write calls against a shared
 * app-wide Spotify limit, and one user failing must not stop the rest.
 */
export async function runScheduledFollowSync(env: Env, now: number = Date.now()): Promise<{ users: number; followed: number }> {
  const rows = await env.DB.prepare(
    `SELECT u.* FROM spotify_follow_syncs s
     JOIN users u ON u.id = s.user_id
     WHERE s.enabled = 1 AND u.deleted_at IS NULL`
  ).all<UserRow>();

  let followed = 0;
  for (const user of rows.results) {
    try {
      const result = await runFollowSync(env, user, now);
      followed += result.followed;
    } catch (error) {
      console.error('runScheduledFollowSync failed for user', user.id, error);
    }
  }
  return { users: rows.results.length, followed };
}
