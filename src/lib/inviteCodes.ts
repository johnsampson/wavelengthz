// Invite-only signup gate, gender-balanced (docs/superpowers/specs/
// 2026-08-09-gender-balanced-invite-gate-design.md). Everything about
// deciding *who* can join lives here; src/routes/auth.ts's new-user
// branches and src/routes/onboarding.ts's grant-on-first-completion call
// into this, but own no invite-specific logic themselves.

// Clubhouse's own number, for an unrelated product -- a starting guess per
// the design doc, worth revisiting once there's a real sense of how fast
// the two genders are actually balancing in practice.
export const INVITE_CODES_PER_MEMBER = 2;

// Issue #173 (Round 8): "make it so connect@wavelengthz.com can invite
// anyone... or make it so connect@, john@johnasampson.com and
// rhsassampson2005@gmail.com drop N new codes at a time -- think social
// media campaign on X." A fixed allowlist rather than a `users.is_admin`
// column/role system -- three specific real accounts get a self-serve
// version of the same lever `POST /internal/invites/generate` already gives
// ops (arbitrary count, target_gender NULL so the code works for anyone),
// reachable from Settings -> Your Invites without needing SEED_SECRET.
// Case-insensitive since Google account emails aren't guaranteed to come
// back in any particular casing.
const INVITE_ADMIN_EMAILS = ['connect@wavelengthz.com', 'john@johnasampson.com', 'rhsassampson2005@gmail.com'];

export function isInviteAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return INVITE_ADMIN_EMAILS.includes(email.toLowerCase());
}

// 32 characters (a clean power of 2, so `byte % 32` below has zero modulo
// bias), excluding 0/O/1/I -- easy to misread off a screen or read aloud,
// per the design doc.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

// Pure -- whether the invite-only gate is currently on. A single choke
// point rather than every caller re-checking `env.INVITE_ONLY` truthiness
// directly, so the "any non-empty value" rule only needs to be right once.
export function isInviteOnly(env: { INVITE_ONLY: string }): boolean {
  return !!env.INVITE_ONLY;
}

/**
 * Atomically claims a code for a brand-new user -- the UPDATE only touches
 * a row that's still unredeemed, so two people racing to redeem the same
 * code can never both succeed (D1_ERROR isn't possible here; the second
 * claim just changes zero rows). Returns whether this call is the one that
 * won.
 */
export async function claimInviteCode(db: D1Database, code: string, userId: string, now: number): Promise<{ claimed: boolean; codeId: string | null }> {
  const row = await db.prepare('SELECT id FROM invite_codes WHERE code = ? AND redeemed_by_user_id IS NULL')
    .bind(code)
    .first<{ id: string }>();
  if (!row) return { claimed: false, codeId: null };

  const result = await db
    .prepare('UPDATE invite_codes SET redeemed_by_user_id = ?, redeemed_at = ?, updated_at = ? WHERE id = ? AND redeemed_by_user_id IS NULL')
    .bind(userId, now, now, row.id)
    .run();
  const claimed = result.meta.changes > 0;
  return { claimed, codeId: claimed ? row.id : null };
}

/**
 * Called once, on the transition from `onboarded_at IS NULL` to set --
 * see src/routes/onboarding.ts. This is the entire self-balancing
 * mechanism: every completed onboarding hands out codes that only work for
 * the OPPOSITE gender, so every invite (from either side) structurally
 * pulls in whichever gender the app has less of. Idempotency is the
 * caller's job (checking the transition, not calling this twice) --
 * calling it twice for the same user would simply grant codes twice, with
 * nothing here to detect or prevent that.
 */
export async function grantInviteCodes(db: D1Database, userId: string, declaredGender: string, now: number): Promise<void> {
  const targetGender = declaredGender === 'male' ? 'female' : 'male';
  const statements = Array.from({ length: INVITE_CODES_PER_MEMBER }, () =>
    db
      .prepare(
        `INSERT INTO invite_codes (id, code, created_by_user_id, target_gender, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(crypto.randomUUID(), generateInviteCode(), userId, targetGender, now, now)
  );
  await db.batch(statements);
}

export interface InviteCodeStatus {
  valid: boolean;
  inviterName?: string | null;
  targetGender?: string | null;
}

/**
 * Backs GET /api/invites/:code (public, no session) -- deliberately never
 * returns the inviter's email or any other PII, just a display name, per
 * the design doc.
 */
export async function lookupInviteCode(db: D1Database, code: string): Promise<InviteCodeStatus> {
  const row = await db
    .prepare(
      `SELECT ic.target_gender, u.display_name FROM invite_codes ic
       LEFT JOIN users u ON u.id = ic.created_by_user_id
       WHERE ic.code = ? AND ic.redeemed_by_user_id IS NULL`
    )
    .bind(code)
    .first<{ target_gender: string | null; display_name: string | null }>();
  if (!row) return { valid: false };
  return { valid: true, inviterName: row.display_name, targetGender: row.target_gender };
}
