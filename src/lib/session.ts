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
  phone_number: string | null;
  phone_verified_at: number | null;
  guidelines_acknowledged_at: number | null;
  safety_tips_acknowledged_at: number | null;
  anthem_track_id: string | null;
  onboarded_at: number | null;
  deleted_at: number | null;
  ghosted_at: number | null;
  created_at: number;
  updated_at: number;
}

// Exported so renewSessionIfDue's own threshold math, and its tests, don't
// have to duplicate this value.
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

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

// Session renewal on activity (issue #145, Round 7 item 2: "still lose
// login state from time to time"). Before this, both the DB row's
// expires_at AND the browser's Max-Age cookie were fixed at exactly
// SESSION_TTL_SECONDS from the moment of login and never touched again --
// so someone who opened the app somewhat regularly, just never within the
// same 30-day window as their very first login, still hit a hard,
// surprising logout. Renewing both here (called once per request from
// src/index.ts's top-level fetch handler, after routing) turns that into
// "30 days since your last visit" instead of "30 days since you first
// logged in".
//
// Throttled to once every SESSION_RENEWAL_INTERVAL_SECONDS, not every
// request: a daily active user costs one extra write (and one extra
// Set-Cookie) per day, not one per request/poll tick.
export const SESSION_RENEWAL_INTERVAL_SECONDS = 60 * 60 * 24; // 1 day

// Returns a fresh Set-Cookie header value once the session is due for
// renewal (and renews the DB row's expires_at to match), or null when
// there's nothing to do -- no session cookie on the request, an
// already-expired/unknown session id (nothing to renew -- getSessionUser
// will 401 it same as before), or one that's simply not due yet. Callers
// append the returned value onto their response's headers; a null return
// means "don't touch the response."
export async function renewSessionIfDue(request: Request, db: D1Database, secure: boolean): Promise<string | null> {
  const sessionId = parseCookie(request, 'wl_session');
  if (!sessionId) return null;

  const now = Date.now();
  const row = await db.prepare(`SELECT expires_at FROM sessions WHERE id = ? AND expires_at > ?`).bind(sessionId, now).first<{ expires_at: number }>();
  if (!row) return null;

  // Still fresh enough -- more than a renewal interval's worth of runway
  // remains before this session actually expires, so renewing now would be
  // pure wasted writes for the entire rest of a normal 30-day session
  // lifetime. Only once it's down to its last day (by default) does this
  // actually do anything.
  const remainingMs = row.expires_at - now;
  if (remainingMs > SESSION_RENEWAL_INTERVAL_SECONDS * 1000) return null;

  const newExpiresAt = now + SESSION_TTL_SECONDS * 1000;
  await db.prepare(`UPDATE sessions SET expires_at = ?, updated_at = ? WHERE id = ?`).bind(newExpiresAt, now, sessionId).run();

  return sessionCookieHeader(sessionId, SESSION_TTL_SECONDS, secure);
}
