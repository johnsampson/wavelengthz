// Issue #168 (part of the 250K-users strategy discussion): forwards
// analytics events to Google Analytics 4's Measurement Protocol, entirely
// server-side. Deliberately not the client-side gtag.js snippet -- this
// app's CSP (src/index.ts) allow-lists nothing Google-related in
// script-src today, and loading a third-party script client-side is
// exactly the render-blocking, ad-blocker-vulnerable pattern public/sw.js's
// own v29 changelog entry already documents moving away from (self-hosting
// Alpine.js instead of a CDN). Sending from the Worker avoids all of that,
// at the cost of GA4 never seeing anything this app doesn't explicitly
// forward -- an acceptable trade given how little this app needs from GA
// beyond reach/engagement counting.
const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

export interface GA4Event {
  clientId: string;
  userId?: string | null;
  sessionId?: string;
  eventName: string;
  params?: Record<string, string | number>;
}

/**
 * Fire-and-forget -- callers should wrap this in ctx.waitUntil, never await
 * it inline on a response. Never throws; a GA outage or misconfiguration
 * must not affect the first-party analytics_events write this always runs
 * alongside.
 *
 * Optional by design: GA4_MEASUREMENT_ID/GA4_API_SECRET unset (the default,
 * until a GA4 property exists) means this no-ops entirely -- same
 * convention as SITE_BASIC_AUTH_USER/SIGHTENGINE_API_USER (src/env.d.ts).
 */
export async function sendToGA4(env: Env, event: GA4Event): Promise<void> {
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) return;

  const params: Record<string, string | number> = { ...event.params };
  // Required for GA4's session/engagement reporting (session duration,
  // engaged sessions, bounce rate) to populate correctly -- without these,
  // Measurement Protocol hits still land in GA (Realtime, Events report)
  // but don't roll up into session-based reports. 1 is the documented
  // minimum engagement_time_msec for a hit to count as "engaged" when
  // there's no real duration to report server-side.
  if (event.sessionId) {
    params.session_id = event.sessionId;
    params.engagement_time_msec = 1;
  }

  const url = `${GA4_ENDPOINT}?measurement_id=${encodeURIComponent(env.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(env.GA4_API_SECRET)}`;
  try {
    await fetch(url, {
      method: 'POST',
      body: JSON.stringify({
        client_id: event.clientId,
        // Never anything PII (email/phone) -- this app's own opaque
        // internal user UUID, same identifier used everywhere else,
        // omitted entirely for an anonymous visitor rather than sent as
        // null/undefined.
        ...(event.userId ? { user_id: event.userId } : {}),
        events: [{ name: event.eventName, params }],
      }),
    });
  } catch (error) {
    console.error('sendToGA4 failed', error);
  }
}
