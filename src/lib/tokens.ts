import { decrypt, encrypt } from './crypto';
import { refreshAccessToken } from './spotify';
import type { UserRow } from './session';

interface MusicSourceTokenRow {
  access_token: string;
  refresh_token: string;
  token_expires_at: number;
}

export async function getValidAccessToken(user: UserRow, env: Env, db: D1Database): Promise<string> {
  const row = await db
    .prepare(`SELECT access_token, refresh_token, token_expires_at FROM music_source_tokens WHERE user_id = ? AND provider = 'spotify'`)
    .bind(user.id)
    .first<MusicSourceTokenRow>();
  if (!row) throw new Error(`No Spotify account linked for user ${user.id}`);

  if (row.token_expires_at > Date.now()) {
    return decrypt(row.access_token, env.TOKEN_ENCRYPTION_KEY);
  }

  const refreshToken = await decrypt(row.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  const fresh = await refreshAccessToken(refreshToken, env);

  const encAccess = await encrypt(fresh.access_token, env.TOKEN_ENCRYPTION_KEY);
  const encRefresh = await encrypt(fresh.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  const expiresAt = Date.now() + fresh.expires_in * 1000;

  // fresh.scope reflects whatever the token was actually issued with -- a
  // refresh can't gain scopes beyond the original /login consent, but
  // keeping this column current (rather than only ever set at login) means
  // it never silently drifts stale if Spotify ever narrows a token's scope
  // out from under it. COALESCE guards against overwriting a known value
  // with NULL on the rare response (or test stub) that omits `scope`.
  await db
    .prepare(
      `UPDATE music_source_tokens SET access_token = ?, refresh_token = ?, token_expires_at = ?, granted_scope = COALESCE(?, granted_scope), updated_at = ? WHERE user_id = ? AND provider = 'spotify'`
    )
    .bind(encAccess, encRefresh, expiresAt, fresh.scope ?? null, Date.now(), user.id)
    .run();

  return fresh.access_token;
}
