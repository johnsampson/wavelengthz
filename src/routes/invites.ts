import type { IRequest, RouterType } from 'itty-router';
import { getSessionUser, requestIsSecure } from '../lib/session';
import { constantTimeEqual } from '../lib/crypto';
import { generateInviteCode, lookupInviteCode, grantInviteCodes } from '../lib/inviteCodes';

export function registerInviteRoutes(router: RouterType) {
  // Public, no session -- the /join landing page calls this before OAuth
  // even starts. Never returns the inviter's email or any other PII.
  router.get('/api/invites/:code', async (request: IRequest, env: Env) => {
    const status = await lookupInviteCode(env.DB, request.params.code);
    return Response.json(status);
  });

  // The /join page's "Continue" action -- a plain server route, not client
  // JS, because httpOnly cookies can only ever be set by a server response.
  // Sets wl_invite_code and hands off to the existing /login provider
  // choice, unchanged. Deliberately does NOT look the code up here: an
  // invalid/already-redeemed code still reaches /login and OAuth, and is
  // caught for real at the one place it actually matters -- the atomic
  // claim in /callback's new-user branch -- consistent with self-attestation
  // being the whole trust model here (see the design doc).
  router.get('/join/continue', async (request: Request, env: Env) => {
    const code = new URL(request.url).searchParams.get('code');
    const headers = new Headers({ Location: '/login' });
    if (code) {
      const secure = requestIsSecure(request);
      headers.append('Set-Cookie', `wl_invite_code=${encodeURIComponent(code)}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=600`);
    }
    return new Response(null, { status: 302, headers });
  });

  // Backs Settings -> "Your Invites": shareable links for codes not yet
  // redeemed, and who redeemed the rest (display name only, mirroring
  // Clubhouse's "people you invited").
  router.get('/api/me/invites', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    // Self-heal for an account that onboarded before this feature existed
    // (issue #127: "did we take the share/invite live? I don't see it").
    // grantInviteCodes (src/lib/inviteCodes.ts) only ever fires on the
    // onboarded_at NULL -> set transition (src/routes/onboarding.ts), so
    // anyone who completed onboarding earlier has zero rows here and no
    // future event that would ever grant them any otherwise. Gated on
    // onboarded_at being set (never grant mid-onboarding; a real completion
    // still grants normally the usual way) and on having never been granted
    // any before (so a member who's already shared/redeemed theirs never
    // gets a surprise second batch just for revisiting this page).
    if (user.onboarded_at != null && user.gender) {
      const alreadyGranted = await env.DB.prepare('SELECT 1 FROM invite_codes WHERE created_by_user_id = ? LIMIT 1')
        .bind(user.id)
        .first();
      if (!alreadyGranted) await grantInviteCodes(env.DB, user.id, user.gender, Date.now());
    }

    const rows = await env.DB.prepare(
      `SELECT ic.code, ic.target_gender, ic.redeemed_at, u.display_name AS redeemed_by_name
       FROM invite_codes ic
       LEFT JOIN users u ON u.id = ic.redeemed_by_user_id
       WHERE ic.created_by_user_id = ?
       ORDER BY ic.created_at ASC`
    )
      .bind(user.id)
      .all<{ code: string; target_gender: string | null; redeemed_at: number | null; redeemed_by_name: string | null }>();

    const invites = rows.results.map((r) => ({
      code: r.code,
      targetGender: r.target_gender,
      redeemed: r.redeemed_at != null,
      redeemedByName: r.redeemed_by_name,
    }));
    return Response.json({ invites });
  });

  // Founding-cohort seeding, before any member exists to invite anyone --
  // and the lever for manually correcting gender balance early on. Same
  // X-Seed-Secret convention as every other admin-trigger endpoint
  // (src/routes/admin.ts).
  router.post('/internal/invites/generate', async (request: IRequest, env: Env) => {
    if (!constantTimeEqual(request.headers.get('X-Seed-Secret') ?? '', env.SEED_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }

    const { count, targetGender } = await request.json<{ count?: number; targetGender?: string | null }>();
    if (!Number.isInteger(count) || count! <= 0) {
      return Response.json({ error: 'invalid_count' }, { status: 400 });
    }
    if (targetGender !== undefined && targetGender !== null && targetGender !== 'male' && targetGender !== 'female') {
      return Response.json({ error: 'invalid_target_gender' }, { status: 400 });
    }

    const now = Date.now();
    const codes = Array.from({ length: count! }, () => generateInviteCode());
    await env.DB.batch(
      codes.map((code) =>
        env.DB.prepare(`INSERT INTO invite_codes (id, code, created_by_user_id, target_gender, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)`)
          .bind(crypto.randomUUID(), code, targetGender ?? null, now, now)
      )
    );

    return Response.json({ codes });
  });
}
