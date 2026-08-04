export interface UserRow {
  id: string;
  spotify_id: string;
  display_name: string | null;
  bio: string | null;
  date_of_birth: string | null;
  age_verified_at: number | null;
  location_label: string | null;
  lat: number | null;
  lng: number | null;
  max_distance_km: number;
  email: string | null;
  spotify_avatar_url: string | null;
  access_token: string;
  refresh_token: string;
  token_expires_at: number;
  onboarded_at: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function sessionCookieHeader(id: string, maxAgeSeconds: number): string {
  return `wl_session=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export async function createSession(
  db: D1Database,
  userId: string
): Promise<{ id: string; cookie: string }> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_SECONDS * 1000;
  await db
    .prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(id, userId, now, expiresAt)
    .run();
  return { id, cookie: sessionCookieHeader(id, SESSION_TTL_SECONDS) };
}

function parseCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export async function getSessionUser(request: Request, db: D1Database): Promise<UserRow | null> {
  const sessionId = parseCookie(request, 'wl_session');
  if (!sessionId) return null;

  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.deleted_at IS NULL`
    )
    .bind(sessionId, Date.now())
    .first<UserRow>();

  return row ?? null;
}
