import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { computeAge } from '../lib/age';

interface OnboardingBody {
  display_name: string;
  bio?: string;
  date_of_birth: string;
  location_label: string;
  lat: number;
  lng: number;
  max_distance_km?: number;
  gender: string;
  seeking: string;
  intent: string;
}

// Fixed sets of options presented in the UI, not freeform-only (same convention
// as VALID_REASONS in src/routes/safety.ts) -- no DB-level CHECK constraint,
// validated here so adding/renaming an option never needs a migration.
const GENDER_OPTIONS = new Set(['male', 'female']);
const SEEKING_OPTIONS = new Set(['male', 'female']);
const INTENT_OPTIONS = new Set([
  'long_term_relationship',
  'something_casual',
  'dating_around',
  'making_friends',
  'not_sure_yet',
]);

const LOCATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BIO_LENGTH = 500;

export function registerOnboardingRoutes(router: RouterType) {
  router.post('/api/onboarding', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const body = await request.json<OnboardingBody>();
    console.log(`POST /api/onboarding user=${user.id} body=${JSON.stringify(body)}`);

    if (
      typeof body.date_of_birth !== 'string' ||
      !body.date_of_birth ||
      Number.isNaN(new Date(body.date_of_birth).getTime())
    ) {
      console.error(`invalid_date_of_birth user=${user.id} date_of_birth=${JSON.stringify(body.date_of_birth)}`);
      return Response.json({ error: 'invalid_date_of_birth' }, { status: 400 });
    }

    const age = computeAge(body.date_of_birth, Date.now());
    if (age < 18) {
      console.error(`underage user=${user.id} date_of_birth=${body.date_of_birth} computedAge=${age}`);
      return Response.json({ error: 'underage' }, { status: 403 });
    }

    if (
      typeof body.lat !== 'number' ||
      Number.isNaN(body.lat) ||
      typeof body.lng !== 'number' ||
      Number.isNaN(body.lng)
    ) {
      console.error(`location_required user=${user.id} lat=${JSON.stringify(body.lat)} lng=${JSON.stringify(body.lng)}`);
      return Response.json({ error: 'location_required' }, { status: 400 });
    }

    if (
      typeof body.display_name !== 'string' ||
      !body.display_name.trim() ||
      !/^[-A-Za-z0-9 ]+$/.test(body.display_name.trim())
    ) {
      console.error(`invalid_display_name user=${user.id} display_name=${JSON.stringify(body.display_name)}`);
      return Response.json({ error: 'invalid_display_name' }, { status: 400 });
    }

    if (body.bio != null && (typeof body.bio !== 'string' || body.bio.length > MAX_BIO_LENGTH)) {
      console.error(`invalid_bio user=${user.id} bioType=${typeof body.bio} bioLength=${typeof body.bio === 'string' ? body.bio.length : 'n/a'}`);
      return Response.json({ error: 'invalid_bio' }, { status: 400 });
    }

    if (typeof body.gender !== 'string' || !GENDER_OPTIONS.has(body.gender)) {
      console.error(`invalid_gender user=${user.id} gender=${JSON.stringify(body.gender)}`);
      return Response.json({ error: 'invalid_gender' }, { status: 400 });
    }

    if (typeof body.seeking !== 'string' || !SEEKING_OPTIONS.has(body.seeking)) {
      console.error(`invalid_seeking user=${user.id} seeking=${JSON.stringify(body.seeking)}`);
      return Response.json({ error: 'invalid_seeking' }, { status: 400 });
    }

    if (typeof body.intent !== 'string' || !INTENT_OPTIONS.has(body.intent)) {
      console.error(`invalid_intent user=${user.id} intent=${JSON.stringify(body.intent)}`);
      return Response.json({ error: 'invalid_intent' }, { status: 400 });
    }

    const now = Date.now();

    // Only a genuine *change* to an already-onboarded user's lat/lng starts (or
    // is blocked by) the cooldown -- the very first onboarding submission is
    // not a "move" and never touches location_updated_at.
    const locationChanged = user.onboarded_at != null && (body.lat !== user.lat || body.lng !== user.lng);
    if (locationChanged && user.location_updated_at != null && now - user.location_updated_at < LOCATION_COOLDOWN_MS) {
      const retryAfterMs = LOCATION_COOLDOWN_MS - (now - user.location_updated_at);
      console.error(`location_change_cooldown user=${user.id} retryAfterMs=${retryAfterMs}`);
      return Response.json({ error: 'location_change_cooldown', retryAfterMs }, { status: 429 });
    }
    const locationUpdatedAt = locationChanged ? now : user.location_updated_at;

    await env.DB.prepare(
      `UPDATE users SET display_name = ?, bio = ?, date_of_birth = ?, age_verified_at = ?, location_label = ?, lat = ?, lng = ?,
        location_updated_at = ?, gender = ?, seeking = ?, intent = ?,
        max_distance_km = COALESCE(?, max_distance_km), onboarded_at = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      body.display_name.trim(),
      body.bio ?? null,
      body.date_of_birth,
      now,
      body.location_label,
      body.lat,
      body.lng,
      locationUpdatedAt,
      body.gender,
      body.seeking,
      body.intent,
      body.max_distance_km ?? null,
      now,
      now,
      user.id
    ).run();

    return Response.json({ ok: true });
  });
}
