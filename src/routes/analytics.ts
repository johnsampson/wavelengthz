import type { RouterType } from 'itty-router';
import { getSessionUser } from '../lib/session';
import { recordEvent, type AnalyticsEventType } from '../lib/analytics';

const VALID_EVENT_TYPES: AnalyticsEventType[] = ['session_start', 'song_play'];

export function registerAnalyticsRoutes(router: RouterType) {
  // Deliberately open to anonymous callers (no session required) -- issue
  // #161 (part of the 250K-users strategy discussion): the whole point is
  // to count reach beyond identified accounts too, not just logged-in
  // usage. getSessionUser attaches a real user_id whenever a session cookie
  // is present; recordEvent's own userId parameter accepts null otherwise.
  // Rate-limited the same as every other /api/* route via src/index.ts's
  // general per-IP limiter -- no dedicated bucket needed for this.
  router.post('/api/analytics/event', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);

    let body: { eventType?: string; metadata?: unknown };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid_body' }, { status: 400 });
    }

    if (!VALID_EVENT_TYPES.includes(body.eventType as AnalyticsEventType)) {
      return Response.json({ error: 'invalid_event_type' }, { status: 400 });
    }

    // Stored as-is once serialized -- this endpoint doesn't interpret
    // metadata's shape, it's a passthrough for whatever a future event_type
    // wants to carry. Caps it at a sane size so one malformed/huge payload
    // can't bloat the table -- same defensive instinct as this codebase's
    // other free-text length caps (e.g. messagingGate's bio length check).
    let metadata: string | undefined;
    if (body.metadata !== undefined) {
      const serialized = JSON.stringify(body.metadata);
      if (serialized.length > 2000) return Response.json({ error: 'metadata_too_large' }, { status: 400 });
      metadata = serialized;
    }

    await recordEvent(env.DB, { userId: user?.id ?? null, eventType: body.eventType as AnalyticsEventType, metadata }, Date.now());
    return Response.json({ ok: true });
  });
}
