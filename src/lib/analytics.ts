// Issue #161 (part of the 250K-users strategy discussion): the minimum
// first-party instrumentation needed to eventually produce a dated,
// exportable "distinct active users" count -- see migrations/0029's own
// comment for why this has to exist at all (Spotify's own MAU verification
// process wants an export from our analytics, not anything Spotify itself
// can see).

// Issue #170: Tier 1 of the broader event-coverage expansion -- the app's
// core engagement loop (swipe, match, message, group, Daily Drop), so the
// analytics_events table (and the GA4 forwarding riding alongside it, see
// src/lib/googleAnalytics.ts) reflects real usage, not just reach. Deliberately
// excludes safety actions (block/report) -- forwarding those to a third-party
// vendor is its own decision, not bundled in here.
export type AnalyticsEventType =
  | 'session_start'
  | 'song_play'
  | 'people_swipe'
  | 'music_swipe'
  | 'match_created'
  | 'message_sent'
  | 'group_created'
  | 'group_joined'
  | 'daily_drop_answered';

/**
 * Records one analytics event. userId is optional -- an anonymous visitor
 * (no session yet) still counts toward reach even before they have an
 * account. metadata is stored as-is (already-serialized JSON, or
 * undefined); callers decide what shape makes sense per event_type rather
 * than this function enforcing one.
 */
export async function recordEvent(
  db: D1Database,
  event: { userId: string | null; eventType: AnalyticsEventType; metadata?: string },
  now: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO analytics_events (id, user_id, event_type, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), event.userId, event.eventType, event.metadata ?? null, now, now)
    .run();
}

/**
 * The actual MAU-style number: how many distinct identified users (rows
 * with a non-null user_id) recorded at least one event since `sinceMs`.
 * Deliberately excludes anonymous events from this count -- "distinct
 * users" has to mean distinct people, and an anonymous row carries no way
 * to tell two visits apart from the same person vs. two different people.
 * anonymousEventCount rides alongside as a separate, honest "reach beyond
 * identified accounts" signal, not folded into the same number.
 */
export async function distinctActiveUserCount(db: D1Database, sinceMs: number): Promise<{ distinctUsers: number; anonymousEvents: number }> {
  const [usersRow, anonRow] = await Promise.all([
    db
      .prepare(`SELECT COUNT(DISTINCT user_id) as count FROM analytics_events WHERE user_id IS NOT NULL AND created_at >= ?`)
      .bind(sinceMs)
      .first<{ count: number }>(),
    db
      .prepare(`SELECT COUNT(*) as count FROM analytics_events WHERE user_id IS NULL AND created_at >= ?`)
      .bind(sinceMs)
      .first<{ count: number }>(),
  ]);
  return { distinctUsers: usersRow?.count ?? 0, anonymousEvents: anonRow?.count ?? 0 };
}
