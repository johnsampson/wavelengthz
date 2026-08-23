import {
  PLAYLIST_ADD_MAX_URIS,
  PLAYLIST_SYNC_SCOPE,
  addTracksToPlaylist,
  createPlaylist,
  isSpotifyAuthFailure,
  playlistIsWritable,
} from './spotify';
import { getValidAccessToken } from './tokens';
import type { UserRow } from './session';

export const PLAYLIST_NAME = 'Wavelengthz';
export const PLAYLIST_DESCRIPTION = 'Songs you liked on Wavelengthz. Synced automatically.';

// Ceiling on how many tracks one invocation will push. A first-time backfill
// can legitimately be hundreds of tracks; sending them all in a single run
// would be up to a dozen back-to-back write calls, which is exactly the burst
// shape that trips Spotify's app-wide limit (see spotify.ts's spotifyFetch
// comment for what that costs -- Development Mode penalties measured in
// hours, not seconds). At PLAYLIST_ADD_MAX_URIS per call this is 3 calls per
// run, and the remainder is picked up by the next scheduled run rather than
// being lost -- pending work is derived, so there's no queue to drain.
export const SYNC_MAX_TRACKS_PER_RUN = 300;

// Right-swiped tracks that carry a Spotify id and haven't been pushed yet.
//
// "Pending" is derived, never stored: there is no queue table to fall out of
// step with the swipes it mirrors. Ordered oldest-first so a backfill lands
// in the playlist in the order the user actually liked things, and so a run
// that hits SYNC_MAX_TRACKS_PER_RUN resumes exactly where it left off.
//
// music_swipes rows for 'track' items reference tracks.id (see
// src/routes/musicSwipes.ts), so the join is what filters out artist swipes
// as well as any track that never made it into the local catalog.
const PENDING_TRACKS_SQL = `
  SELECT t.spotify_id as spotify_id
  FROM music_swipes ms
  JOIN tracks t ON t.id = ms.item_id
  WHERE ms.user_id = ?
    AND ms.item_type = 'track'
    AND ms.direction = 'right'
    AND t.spotify_id IS NOT NULL AND t.spotify_id != ''
    AND NOT EXISTS (
      SELECT 1 FROM spotify_playlist_sync_items i
      WHERE i.user_id = ms.user_id AND i.spotify_track_id = t.spotify_id
    )
  ORDER BY ms.created_at ASC
`;

export interface PlaylistSyncRow {
  id: string;
  enabled: number;
  playlist_id: string | null;
  playlist_url: string | null;
  last_synced_at: number | null;
  needs_reconnect: number;
}

export interface PlaylistSyncStatus {
  enabled: boolean;
  /** Whether the account actually consented to PLAYLIST_SYNC_SCOPE. */
  connected: boolean;
  playlistUrl: string | null;
  lastSyncedAt: number | null;
  pendingCount: number;
  syncedCount: number;
  /**
   * True when sync is off because Spotify revoked access, not because the
   * user chose to turn it off -- persisted (migrations/0027), not just a
   * one-time toast, so it still reads correctly on a later page load after
   * the moment it happened.
   */
  needsReconnect: boolean;
}

export type SyncSkipReason = 'disabled' | 'scope_missing' | 'no_spotify';

export interface SyncResult {
  added: number;
  /** Set when nothing was attempted; `added` is 0 and no call was made. */
  skipped?: SyncSkipReason;
  /** True when Spotify rejected our credentials -- needs re-consent, not a retry. */
  needsReconnect?: boolean;
  /** True when more work remains after SYNC_MAX_TRACKS_PER_RUN. */
  hasMore?: boolean;
}

export function hasPlaylistScope(grantedScope: string | null | undefined): boolean {
  return grantedScope?.split(' ').includes(PLAYLIST_SYNC_SCOPE) ?? false;
}

export async function getSyncRow(db: D1Database, userId: string): Promise<PlaylistSyncRow | null> {
  return db
    .prepare('SELECT id, enabled, playlist_id, playlist_url, last_synced_at, needs_reconnect FROM spotify_playlist_syncs WHERE user_id = ?')
    .bind(userId)
    .first<PlaylistSyncRow>();
}

async function getSpotifyAccount(
  db: D1Database,
  userId: string
): Promise<{ provider_user_id: string; granted_scope: string | null } | null> {
  return db
    .prepare(`SELECT provider_user_id, granted_scope FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`)
    .bind(userId)
    .first<{ provider_user_id: string; granted_scope: string | null }>();
}

export async function countPendingTracks(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as c FROM (${PENDING_TRACKS_SQL})`)
    .bind(userId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Everything the settings UI needs, with zero Spotify calls -- all four
 * numbers come from D1. Deliberately cheap: this runs on every visit to the
 * connections page, and nothing here is worth spending Spotify quota on.
 */
export async function getSyncStatus(db: D1Database, userId: string): Promise<PlaylistSyncStatus> {
  const [row, account, pendingCount, syncedRow] = await Promise.all([
    getSyncRow(db, userId),
    getSpotifyAccount(db, userId),
    countPendingTracks(db, userId),
    db
      .prepare('SELECT COUNT(*) as c FROM spotify_playlist_sync_items WHERE user_id = ?')
      .bind(userId)
      .first<{ c: number }>(),
  ]);

  return {
    enabled: row?.enabled === 1,
    connected: hasPlaylistScope(account?.granted_scope),
    playlistUrl: row?.playlist_url ?? null,
    lastSyncedAt: row?.last_synced_at ?? null,
    pendingCount,
    syncedCount: syncedRow?.c ?? 0,
    needsReconnect: row?.needs_reconnect === 1,
  };
}

/**
 * `needsReconnect` defaults to false: every ordinary caller (an explicit
 * enable via the OAuth callback, an explicit disable via the Settings
 * toggle) is a real, current, intentional state change that supersedes
 * whatever reason sync was previously off for -- only the auth-failure path
 * in runPlaylistSync below passes true.
 */
export async function setSyncEnabled(db: D1Database, userId: string, enabled: boolean, now: number, needsReconnect = false): Promise<void> {
  await db
    .prepare(
      `INSERT INTO spotify_playlist_syncs (id, user_id, enabled, needs_reconnect, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, needs_reconnect = excluded.needs_reconnect, updated_at = excluded.updated_at`
    )
    .bind(crypto.randomUUID(), userId, enabled ? 1 : 0, needsReconnect ? 1 : 0, now, now)
    .run();
}

/**
 * Resolve the playlist to write into, creating one if needed.
 *
 * Re-verifies an existing id rather than trusting it forever: a user can
 * delete (unfollow) the playlist from Spotify at any time, and writing into a
 * dead id would fail silently-ish on every run from then on. One extra read
 * call per sync run, which is cheap next to being permanently broken.
 */
async function resolvePlaylist(
  db: D1Database,
  userId: string,
  token: string,
  spotifyUserId: string,
  existing: PlaylistSyncRow | null,
  now: number
): Promise<{ playlistId: string; playlistUrl: string | null }> {
  if (existing?.playlist_id) {
    if (await playlistIsWritable(token, existing.playlist_id, spotifyUserId)) {
      return { playlistId: existing.playlist_id, playlistUrl: existing.playlist_url };
    }
  }

  const created = await createPlaylist(token, spotifyUserId, PLAYLIST_NAME, PLAYLIST_DESCRIPTION);
  const url = created.external_urls?.spotify ?? null;
  await db
    .prepare('UPDATE spotify_playlist_syncs SET playlist_id = ?, playlist_url = ?, updated_at = ? WHERE user_id = ?')
    .bind(created.id, url, now, userId)
    .run();

  // A brand-new playlist means the old one is gone, taking its contents with
  // it. The ledger has to go too, or every track already "sent" would be
  // permanently absent from the replacement -- the one case where re-sending
  // is correct rather than fighting the user.
  await db.prepare('DELETE FROM spotify_playlist_sync_items WHERE user_id = ?').bind(userId).run();

  return { playlistId: created.id, playlistUrl: url };
}

/**
 * Push pending liked tracks into the user's Wavelengthz playlist.
 *
 * The single write path, shared by the "Sync now" button and the cron -- an
 * initial backfill and ongoing sync are the same operation, because pending
 * work is derived rather than queued.
 *
 * Makes no Spotify calls at all unless there is genuinely something to send,
 * and never runs without both an explicit enabled flag and a real
 * PLAYLIST_SYNC_SCOPE grant.
 */
export async function runPlaylistSync(env: Env, user: UserRow, now: number = Date.now()): Promise<SyncResult> {
  const db = env.DB;
  const row = await getSyncRow(db, user.id);
  if (row?.enabled !== 1) return { added: 0, skipped: 'disabled' };

  const account = await getSpotifyAccount(db, user.id);
  if (!account) return { added: 0, skipped: 'no_spotify' };
  if (!hasPlaylistScope(account.granted_scope)) return { added: 0, skipped: 'scope_missing' };

  // Cheap D1-only gate first, so the common "nothing new since last run" case
  // costs zero Spotify calls -- including the playlist check below.
  if ((await countPendingTracks(db, user.id)) === 0) {
    await db
      .prepare('UPDATE spotify_playlist_syncs SET last_synced_at = ?, updated_at = ? WHERE user_id = ?')
      .bind(now, now, user.id)
      .run();
    return { added: 0 };
  }

  try {
    const token = await getValidAccessToken(user, env, db);
    const { playlistId } = await resolvePlaylist(db, user.id, token, account.provider_user_id, row, now);

    // Deliberately read AFTER resolvePlaylist, not before: recreating a
    // deleted playlist wipes the ledger (everything previously sent is gone
    // with the old playlist), which changes what "pending" means. Reading
    // first would send only the newly-liked tracks and strand every
    // previously-synced one in a playlist that no longer exists.
    //
    // Reads one past the cap purely to report hasMore honestly, so the UI can
    // say "more to come" rather than looking finished with work outstanding.
    const pending = await db
      .prepare(`${PENDING_TRACKS_SQL} LIMIT ?`)
      .bind(user.id, SYNC_MAX_TRACKS_PER_RUN + 1)
      .all<{ spotify_id: string }>();

    const hasMore = pending.results.length > SYNC_MAX_TRACKS_PER_RUN;
    const trackIds = pending.results.slice(0, SYNC_MAX_TRACKS_PER_RUN).map((r) => r.spotify_id);

    let added = 0;
    for (let i = 0; i < trackIds.length; i += PLAYLIST_ADD_MAX_URIS) {
      const chunk = trackIds.slice(i, i + PLAYLIST_ADD_MAX_URIS);
      await addTracksToPlaylist(token, playlistId, chunk.map((id) => `spotify:track:${id}`));

      // Ledger written per chunk, immediately after that chunk lands -- not
      // once at the end. If a later chunk fails, what already went out stays
      // recorded, so the retry sends the remainder instead of duplicating
      // everything that already succeeded.
      await db.batch(
        chunk.map((spotifyTrackId) =>
          db
            .prepare(
              `INSERT INTO spotify_playlist_sync_items (id, user_id, spotify_track_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(user_id, spotify_track_id) DO NOTHING`
            )
            .bind(crypto.randomUUID(), user.id, spotifyTrackId, now, now)
        )
      );
      added += chunk.length;
    }

    await db
      .prepare('UPDATE spotify_playlist_syncs SET last_synced_at = ?, updated_at = ? WHERE user_id = ?')
      .bind(now, now, user.id)
      .run();

    return { added, hasMore };
  } catch (error) {
    // Access revoked from Spotify's side (the user can do this at any time,
    // from their Spotify account page, without touching this app). Turn sync
    // off so the cron stops retrying a grant that no longer exists, and
    // report it so the UI can offer reconnect rather than a generic failure.
    if (isSpotifyAuthFailure(error)) {
      await setSyncEnabled(db, user.id, false, now, true);
      return { added: 0, needsReconnect: true };
    }
    throw error;
  }
}

/**
 * Cron entry point: sync every user who has opted in.
 *
 * Sequential, not Promise.all -- these are write calls against a shared
 * app-wide Spotify rate limit, and fanning them out across all opted-in users
 * simultaneously is the burst pattern this codebase has repeatedly been
 * burned by. One user failing must not stop the rest, so each is isolated.
 */
export async function runScheduledPlaylistSync(env: Env, now: number = Date.now()): Promise<{ users: number; added: number }> {
  // u.* rather than a hand-picked column list: the rows are handed straight
  // to runPlaylistSync as UserRow, and selecting a subset would make that
  // type a claim the query doesn't actually back.
  const rows = await env.DB.prepare(
    `SELECT u.* FROM spotify_playlist_syncs s
     JOIN users u ON u.id = s.user_id
     WHERE s.enabled = 1 AND u.deleted_at IS NULL`
  ).all<UserRow>();

  let added = 0;
  for (const user of rows.results) {
    try {
      const result = await runPlaylistSync(env, user, now);
      added += result.added;
    } catch (error) {
      console.error('runScheduledPlaylistSync failed for user', user.id, error);
    }
  }
  return { users: rows.results.length, added };
}
