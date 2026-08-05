import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { lookupPhoneNumber, startVerification, checkVerification, isBlockedLineType } from '../lib/twilio';

// Loose E.164 check -- Twilio's own APIs reject anything that isn't a real
// number anyway; this just avoids spending a Lookup/Verify call (both cost
// money) on obviously malformed input.
const E164_RE = /^\+[1-9]\d{6,14}$/;

export function registerPhoneRoutes(router: RouterType) {
  router.post('/api/phone/verify/start', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { phoneNumber } = await request.json<{ phoneNumber: string }>();
    if (typeof phoneNumber !== 'string' || !E164_RE.test(phoneNumber)) {
      return Response.json({ error: 'invalid_phone_number' }, { status: 400 });
    }

    let lookup;
    try {
      lookup = await lookupPhoneNumber(phoneNumber, env);
    } catch (err) {
      console.error('lookupPhoneNumber failed', err);
      return Response.json({ error: 'lookup_failed' }, { status: 502 });
    }
    if (!lookup.valid) return Response.json({ error: 'invalid_phone_number' }, { status: 400 });

    // Checked -- and rejected -- before a Verify (and therefore any SMS) is
    // ever sent. See src/lib/twilio.ts's isBlockedLineType.
    if (isBlockedLineType(lookup.lineType)) {
      return Response.json({ error: 'voip_not_allowed' }, { status: 400 });
    }

    try {
      await startVerification(lookup.phoneNumber, env);
    } catch (err) {
      console.error('startVerification failed', err);
      return Response.json({ error: 'verification_start_failed' }, { status: 502 });
    }

    return Response.json({ ok: true });
  });

  router.post('/api/phone/verify/check', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const { phoneNumber, code } = await request.json<{ phoneNumber: string; code: string }>();
    if (typeof phoneNumber !== 'string' || !E164_RE.test(phoneNumber) || typeof code !== 'string' || !code.trim()) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }

    let result;
    try {
      result = await checkVerification(phoneNumber, code, env);
    } catch (err) {
      console.error('checkVerification failed', err);
      return Response.json({ error: 'verification_check_failed' }, { status: 502 });
    }
    if (!result.approved) return Response.json({ error: 'invalid_code' }, { status: 400 });

    // A pre-check rather than relying on the unique index to reject the
    // UPDATE below -- consistent with this codebase's existing convention
    // (see src/routes/groups.ts's join, src/lib/catalogUpsert.ts) of an
    // explicit SELECT before the write. The race this leaves open (two
    // people verifying the same number in the same instant) is negligible
    // for a once-per-account action like this.
    const existing = await env.DB.prepare('SELECT id FROM users WHERE phone_number = ? AND id != ?')
      .bind(phoneNumber, user.id)
      .first<{ id: string }>();
    if (existing) return Response.json({ error: 'phone_already_verified' }, { status: 409 });

    await env.DB.prepare('UPDATE users SET phone_number = ?, phone_verified_at = ? WHERE id = ?')
      .bind(phoneNumber, Date.now(), user.id)
      .run();

    return Response.json({ ok: true });
  });
}
