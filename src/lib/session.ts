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
  location_updated_at: number | null;
  max_distance_km: number;
  age_min: number;
  age_max: number;
  gender: string | null;
  seeking: string | null;
  intent: string | null;
  email: string | null;
  email_notifications_enabled: number;
  anthem_track_id: string | null;
  onboarded_at: number | null;
  deleted_at: number | null;
  ghosted_at: number | null;
  created_at: number;
  updated_at: number;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// Safari (unlike Chromium) enforces `Secure` literally -- it refuses to store
// or send the cookie back over plain HTTP even for localhost/127.0.0.1. Local
// dev runs wrangler over http://127.0.0.1, so a hardcoded `Secure` silently
// drops every auth cookie in Safari: the state cookie on /login, the session
// cookie on /callback, and the clear-cookie on /logout. Every caller derives
// `secure` from the live request's protocol (requestIsSecure below) so this
// self-corrects once deployed behind real HTTPS.
export function sessionCookieHeader(id: string, maxAgeSeconds: number, secure: boolean = true): string {
  return `wl_session=${id}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

// Cloudflare's edge sets CF-Visitor (`{"scheme":"https"}`) reliably for any
// request that passed through it, including a Cloudflare Tunnel's public
// hostname -- unlike X-Forwarded-Proto, which `cloudflared` does NOT forward
// when proxying an HTTPS public request to a plain-HTTP local origin (a
// documented gap: github.com/cloudflare/cloudflared/issues/1245). Without
// this, a tunneled local dev session (SPOTIFY_ALLOWED_HOSTS set to a Tunnel
// hostname) sees every request as http even though the public/browser side
// is genuinely https -- wrong for the Secure cookie flag, and fatal for
// auth.ts's redirect_uri construction, which Spotify then rejects outright
// (it requires https for any host other than the 127.0.0.1 loopback).
// Deployed Workers traffic never carries this ambiguity in the first place
// (request.url's protocol is already correct there), so this only changes
// behavior for a request tunneled to a local dev instance.
export function requestIsSecure(request: Request): boolean {
  const cfVisitor = request.headers.get('CF-Visitor');
  if (cfVisitor) {
    try {
      const { scheme } = JSON.parse(cfVisitor);
      if (scheme === 'https') return true;
      if (scheme === 'http') return false;
    } catch {
      // Malformed header -- fall through to the URL-based check below.
    }
  }
  return new URL(request.url).protocol === 'https:';
}

export function requestProtocol(request: Request): string {
  return requestIsSecure(request) ? 'https:' : 'http:';
}

export async function createSession(
  db: D1Database,
  userId: string,
  secure: boolean = true
): Promise<{ id: string; cookie: string }> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_SECONDS * 1000;
  await db
    .prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, userId, now, expiresAt, now)
    .run();
  return { id, cookie: sessionCookieHeader(id, SESSION_TTL_SECONDS, secure) };
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
