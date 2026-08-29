import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { computeAge } from '../lib/age';
import { containsBlockedWord } from '../lib/messageFilter';
import { grantInviteCodes } from '../lib/inviteCodes';
import { reverseGeocodeLabel } from '../lib/geocode';

// The literal placeholder both public/onboarding.html's and
// public/settings/preferences.js's useBrowserLocation() send as
// location_label whenever someone shares their browser's geolocation
// rather than typing a city themselves -- see reverseGeocodeLabel's own
// comment (src/lib/geocode.ts) for the issue #145 (Round 7) item 3 this
// resolves.
const BROWSER_LOCATION_PLACEHOLDER = 'Current location';

interface OnboardingBody {
  display_name: string;
  bio?: string;
  date_of_birth: string;
  location_label: string;
  lat: number;
  lng: number;
  max_distance_km?: number;
  age_min?: number;
  age_max?: number;
  gender: string;
  seeking: string;
  intent: string;
}

// Fixed sets of options presented in the UI, not freeform-only (same convention
// as VALID_REASONS in src/routes/safety.ts) -- no DB-level CHECK constraint,
// validated here so adding/renaming an option never needs a migration.
const GENDER_OPTIONS = new Set(['male', 'female']);
// 'friends' is seeking-only -- there's no matching gender, by design. It
// means "match me with anyone else also seeking friends, regardless of
// gender" (src/routes/peopleSwipes.ts's RECIPROCITY_SQL), not a fourth
// gender identity.
const SEEKING_OPTIONS = new Set(['male', 'female', 'friends']);
// 'making_friends' retired here in favor of the real seeking:'friends'
// filter above -- keeping both would give onboarding two different "I want
// friends" signals, only one of which actually did anything.
// 'dating_around' retired too -- it and 'something_casual' are the same
// option from a user's perspective, just two buttons for one idea. Existing
// rows with the old value aren't migrated (see public/settings.js's identical
// handling of 'making_friends'): a stale value simply doesn't match any
// current option, so the next Settings visit shows no intent selected and
// prompts a fresh pick rather than silently keeping (or rejecting) the old one.
const INTENT_OPTIONS = new Set([
  'long_term_relationship',
  'something_casual',
  'not_sure_yet',
]);

const LOCATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BIO_LENGTH = 500;
const MIN_AGE = 18;
const MAX_AGE = 100;

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

    if (
      body.bio != null &&
      (typeof body.bio !== 'string' || body.bio.length > MAX_BIO_LENGTH || containsBlockedWord(body.bio))
    ) {
      console.error(`invalid_bio user=${user.id} bioType=${typeof body.bio} bioLength=${typeof body.bio === 'string' ? body.bio.length : 'n/a'}`);
      return Response.json({ error: 'invalid_bio' }, { status: 400 });
    }

    // Gender is a one-time choice, locked in at initial onboarding and never
    // writable again -- Preferences (public/settings/preferences.html) shows
    // it read-only for exactly this reason. Enforced here, not just in the
    // UI: this endpoint is reused for every later Settings save (see
    // public/settings/preferences.js's comment on why), so relying on the
    // client to keep re-sending the unchanged value would make the lock
    // nothing more than a suggestion -- a hand-crafted request could still
    // flip it. body.gender is validated (and used) ONLY on the very first,
    // pre-onboarding call; on every later call it's inert -- not validated,
    // not written, whatever the request sends -- and user.gender (the
    // existing value) is what actually gets persisted below.
    if (user.onboarded_at == null && (typeof body.gender !== 'string' || !GENDER_OPTIONS.has(body.gender))) {
      console.error(`invalid_gender user=${user.id} gender=${JSON.stringify(body.gender)}`);
      return Response.json({ error: 'invalid_gender' }, { status: 400 });
    }
    const gender = user.onboarded_at == null ? body.gender : user.gender;

    if (typeof body.seeking !== 'string' || !SEEKING_OPTIONS.has(body.seeking)) {
      console.error(`invalid_seeking user=${user.id} seeking=${JSON.stringify(body.seeking)}`);
      return Response.json({ error: 'invalid_seeking' }, { status: 400 });
    }

    if (typeof body.intent !== 'string' || !INTENT_OPTIONS.has(body.intent)) {
      console.error(`invalid_intent user=${user.id} intent=${JSON.stringify(body.intent)}`);
      return Response.json({ error: 'invalid_intent' }, { status: 400 });
    }

    // Both bounds are always sent together by the settings slider -- accepting
    // just one would let a stale age_max linger below a freshly-raised
    // age_min (or vice versa) via the COALESCE update below.
    if (body.age_min !== undefined || body.age_max !== undefined) {
      if (
        !Number.isInteger(body.age_min) ||
        !Number.isInteger(body.age_max) ||
        body.age_min! < MIN_AGE ||
        body.age_max! > MAX_AGE ||
        body.age_min! > body.age_max!
      ) {
        console.error(`invalid_age_range user=${user.id} age_min=${JSON.stringify(body.age_min)} age_max=${JSON.stringify(body.age_max)}`);
        return Response.json({ error: 'invalid_age_range' }, { status: 400 });
      }

      // Safety guardrail: a search range that excludes the searcher's own age
      // (e.g. a 45-year-old only searching 18-25) is a hallmark of predatory
      // targeting rather than a genuine preference, so it's rejected outright
      // rather than merely discouraged.
      if (age < body.age_min! || age > body.age_max!) {
        console.error(`age_range_excludes_self user=${user.id} age=${age} age_min=${body.age_min} age_max=${body.age_max}`);
        return Response.json({ error: 'age_range_excludes_self' }, { status: 400 });
      }
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

    // Resolve the "Current location" placeholder to a real "City, Region"
    // (or as close as BigDataCloud's data can get) before it's ever
    // persisted, so Settings/the profile page show something a person
    // actually recognizes instead of the literal placeholder string.
    // Skipped entirely for manual free-text entry -- someone who typed
    // their own label already gave us exactly what they want shown.
    let locationLabel = body.location_label;
    if (locationLabel === BROWSER_LOCATION_PLACEHOLDER) {
      const resolved = await reverseGeocodeLabel(body.lat, body.lng);
      if (resolved) locationLabel = resolved;
    }

    await env.DB.prepare(
      `UPDATE users SET display_name = ?, bio = ?, date_of_birth = ?, age_verified_at = ?, location_label = ?, lat = ?, lng = ?,
        location_updated_at = ?, gender = ?, seeking = ?, intent = ?,
        max_distance_km = COALESCE(?, max_distance_km),
        age_min = COALESCE(?, age_min), age_max = COALESCE(?, age_max),
        onboarded_at = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      body.display_name.trim(),
      body.bio ?? null,
      body.date_of_birth,
      now,
      locationLabel,
      body.lat,
      body.lng,
      locationUpdatedAt,
      gender,
      body.seeking,
      body.intent,
      body.max_distance_km ?? null,
      body.age_min ?? null,
      body.age_max ?? null,
      now,
      now,
      user.id
    ).run();

    // The entire self-balancing mechanism (docs/superpowers/specs/2026-08-09-
    // gender-balanced-invite-gate-design.md): the moment someone finishes
    // onboarding for the first time, they're handed codes that only work for
    // the OPPOSITE gender they just declared -- gender is validated against
    // GENDER_OPTIONS ('male'/'female') a few lines up, so it's never the
    // 'friends'-only seeking value this check would otherwise mishandle.
    // Gated on the pre-update `user.onboarded_at == null` (this transition,
    // not every later Settings save through this same endpoint) so it fires
    // exactly once per account, ever.
    if (user.onboarded_at == null) {
      // body.gender, not the `gender` local -- already validated as a member
      // of GENDER_OPTIONS above, and always what `gender` equals in this
      // branch, but referencing it directly avoids relying on TS narrowing
      // through the ternary that assigned `gender`.
      await grantInviteCodes(env.DB, user.id, body.gender, now);
    }

    return Response.json({ ok: true });
  });
}
