import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { computeAge } from '../lib/age';

interface OnboardingBody {
  bio?: string;
  date_of_birth: string;
  location_label: string;
  lat: number;
  lng: number;
  max_distance_km?: number;
}

export function registerOnboardingRoutes(router: RouterType) {
  router.post('/api/onboarding', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });

    const body = await request.json<OnboardingBody>();
    if (
      typeof body.date_of_birth !== 'string' ||
      !body.date_of_birth ||
      Number.isNaN(new Date(body.date_of_birth).getTime())
    ) {
      return Response.json({ error: 'invalid_date_of_birth' }, { status: 400 });
    }

    const age = computeAge(body.date_of_birth, Date.now());
    if (age < 18) {
      return Response.json({ error: 'underage' }, { status: 403 });
    }

    if (
      typeof body.lat !== 'number' ||
      Number.isNaN(body.lat) ||
      typeof body.lng !== 'number' ||
      Number.isNaN(body.lng)
    ) {
      return Response.json({ error: 'location_required' }, { status: 400 });
    }

    const now = Date.now();
    await env.DB.prepare(
      `UPDATE users SET bio = ?, date_of_birth = ?, age_verified_at = ?, location_label = ?, lat = ?, lng = ?,
        max_distance_km = COALESCE(?, max_distance_km), onboarded_at = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      body.bio ?? null,
      body.date_of_birth,
      now,
      body.location_label,
      body.lat,
      body.lng,
      body.max_distance_km ?? null,
      now,
      now,
      user.id
    ).run();

    return Response.json({ ok: true });
  });
}
