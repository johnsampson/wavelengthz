import type { RouterType, IRequest } from 'itty-router';
import { getSessionUser, type UserRow } from '../lib/session';
import { resolveSharedTrack, loadSharedTracks, type ShareableSpotifyTrack } from '../lib/trackSharing';
import { primaryPhotoUrls } from '../lib/photos';
import { RECIPROCITY_SQL, reciprocityParams } from './peopleSwipes';
import { currentDayIndex, promptSortOrderForDay } from '../lib/dailyDrop';

// How many of today's other answers to return. Not paginated in v1 -- a
// single day's answer count is bounded by the active user base, and this
// is a browse list, not a feed meant to be scrolled indefinitely.
const ANSWERS_LIMIT = 100;

// Deliberately looser than messagingGate's thresholds (src/lib/messagingGate.ts):
// this is meant to be the *lower*-friction habit, not gated behind the same
// bar as messaging. gender/seeking are required (not just onboarded_at)
// because the browse list's reciprocity filter is undefined without both,
// same reasoning as peopleSwipes.ts's own candidates-pool gate.
function canUseDailyDrop(user: UserRow): boolean {
  return user.onboarded_at != null && user.gender != null && user.seeking != null;
}

interface PromptRow {
  id: string;
  text: string;
  theme: string;
}

async function loadTodaysPrompt(db: D1Database): Promise<{ prompt: PromptRow; dayIndex: number }> {
  const dayIndex = currentDayIndex(Date.now());
  const sortOrder = promptSortOrderForDay(dayIndex);
  const prompt = await db.prepare('SELECT id, text, theme FROM daily_prompts WHERE sort_order = ?').bind(sortOrder).first<PromptRow>();
  // Only possible if the seed migration's row count and DAILY_PROMPT_BANK_SIZE
  // (src/lib/dailyDrop.ts) ever drift apart -- treat as a genuine server error
  // rather than silently rendering an empty prompt.
  if (!prompt) throw new Error(`No daily_prompts row at sort_order=${sortOrder}`);
  return { prompt, dayIndex };
}

export function registerDailyDropRoutes(router: RouterType) {
  router.get('/api/daily-drop', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });
    if (!canUseDailyDrop(user)) return Response.json({ error: 'onboarding_incomplete' }, { status: 400 });

    const { prompt, dayIndex } = await loadTodaysPrompt(env.DB);

    const [answerRow, countRow] = await Promise.all([
      env.DB.prepare('SELECT track_id FROM daily_drop_answers WHERE user_id = ? AND day_index = ?')
        .bind(user.id, dayIndex)
        .first<{ track_id: string }>(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM daily_drop_answers WHERE day_index = ?').bind(dayIndex).first<{ n: number }>(),
    ]);

    const myAnswer = answerRow ? (await loadSharedTracks(env.DB, [answerRow.track_id])).get(answerRow.track_id) ?? null : null;

    return Response.json({
      prompt: { id: prompt.id, text: prompt.text, theme: prompt.theme },
      myAnswer,
      answerCount: countRow?.n ?? 0,
    });
  });

  router.post('/api/daily-drop/answer', async (request: IRequest, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });
    if (!canUseDailyDrop(user)) return Response.json({ error: 'onboarding_incomplete' }, { status: 400 });

    const { track } = await request.json<{ track?: ShareableSpotifyTrack }>();
    if (!track) return Response.json({ error: 'invalid_track' }, { status: 400 });

    const resolved = await resolveSharedTrack(env, track, user.id);
    if ('error' in resolved) {
      return Response.json({ error: resolved.error }, { status: resolved.error === 'artist_unavailable' ? 503 : 400 });
    }

    const { prompt, dayIndex } = await loadTodaysPrompt(env.DB);
    const now = Date.now();

    // Resubmitting the same day overwrites (a change of mind before the day
    // rolls over), rather than a second row -- UNIQUE(user_id, day_index)
    // makes this a straightforward upsert.
    await env.DB.prepare(
      `INSERT INTO daily_drop_answers (id, user_id, day_index, prompt_id, track_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, day_index) DO UPDATE SET track_id = excluded.track_id, prompt_id = excluded.prompt_id, updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), user.id, dayIndex, prompt.id, resolved.trackId, now, now).run();

    const myAnswer = (await loadSharedTracks(env.DB, [resolved.trackId])).get(resolved.trackId) ?? null;
    return Response.json({ myAnswer });
  });

  // Viewable for anyone eligible under the same reciprocity/block rules as
  // the deck's own candidate pool (RECIPROCITY_SQL, src/routes/peopleSwipes.ts)
  // -- this is "a new matching surface" per the source spec, not an open
  // community feed. Tapping a card is meant to hand off to the already-
  // existing GET /api/people/:id/profile (which already supports viewing
  // and swiping pre-match) -- no new interaction primitive needed here.
  router.get('/api/daily-drop/answers', async (request: Request, env: Env) => {
    const user = await getSessionUser(request, env.DB);
    if (!user) return new Response('Unauthorized', { status: 401 });
    if (!canUseDailyDrop(user)) return Response.json({ error: 'onboarding_incomplete' }, { status: 400 });

    const { dayIndex } = await loadTodaysPrompt(env.DB);

    const rows = await env.DB.prepare(
      `SELECT dda.user_id, dda.track_id, u.display_name
       FROM daily_drop_answers dda
       JOIN users u ON u.id = dda.user_id
       WHERE dda.day_index = ? AND dda.user_id != ?
         AND u.deleted_at IS NULL AND u.ghosted_at IS NULL AND u.onboarded_at IS NOT NULL
         AND (${RECIPROCITY_SQL})
         AND NOT EXISTS (
           SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?)
         )
       ORDER BY dda.created_at DESC
       LIMIT ?`
    )
      .bind(dayIndex, user.id, ...reciprocityParams(user), user.id, user.id, ANSWERS_LIMIT)
      .all<{ user_id: string; track_id: string; display_name: string | null }>();

    const userIds = rows.results.map((r) => r.user_id);
    const trackIds = rows.results.map((r) => r.track_id);
    const [photos, tracks] = await Promise.all([primaryPhotoUrls(env.DB, userIds), loadSharedTracks(env.DB, trackIds)]);

    const answers = rows.results
      .map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        photoUrl: photos.get(r.user_id) ?? null,
        track: tracks.get(r.track_id) ?? null,
      }))
      // A track that failed to batch-load (shouldn't happen -- every row here
      // came from a successful resolveSharedTrack) is dropped rather than
      // rendered broken.
      .filter((a) => a.track != null);

    return Response.json({ answers });
  });
}
