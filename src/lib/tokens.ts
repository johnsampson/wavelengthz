import { decrypt, encrypt } from './crypto';
import { refreshAccessToken } from './spotify';
import type { UserRow } from './session';

export async function getValidAccessToken(user: UserRow, env: Env, db: D1Database): Promise<string> {
  if (user.token_expires_at > Date.now()) {
    return decrypt(user.access_token, env.TOKEN_ENCRYPTION_KEY);
  }

  const refreshToken = await decrypt(user.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  const fresh = await refreshAccessToken(refreshToken, env);

  const encAccess = await encrypt(fresh.access_token, env.TOKEN_ENCRYPTION_KEY);
  const encRefresh = await encrypt(fresh.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  const expiresAt = Date.now() + fresh.expires_in * 1000;

  await db
    .prepare(`UPDATE users SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ? WHERE id = ?`)
    .bind(encAccess, encRefresh, expiresAt, Date.now(), user.id)
    .run();

  return fresh.access_token;
}
