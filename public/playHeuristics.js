// Pure helpers behind the player bar's "give the artist a real chance at a
// counted stream" behavior. Kept separate from playerBar.js specifically so
// they're unit-testable -- that module can't be exercised in this repo's test
// pool (no `document`), same split as nav.js's renderNavHtml.

// Spotify counts a stream -- and pays the rightsholder -- once a track has
// been played for 30 seconds. That's Spotify's rule, applied by Spotify to
// their own accounting; nothing here changes whether a play counts. This
// constant only governs when THIS app records "that listen was long enough
// to have counted", so the ratio in track_plays reflects the same boundary
// Spotify uses.
export const PLAY_THRESHOLD_MS = 30_000;

// Fraction of the way into a track to start. Most songs spend their opening
// on an intro, so starting at 0:00 means the first 30 seconds -- exactly the
// window that decides whether a stream counts -- is the least compelling part
// of the song.
const HOOK_FRACTION = 0.2;

// Never skip deeper than this regardless of length. 20% of a 9-minute track
// is nearly two minutes in, which stops being "the hook" and starts being
// "somewhere random in the middle".
const HOOK_MAX_OFFSET_MS = 45_000;

// Short tracks (interludes, punk songs, skits) start at 0:00 -- there's no
// intro worth skipping and the margin for error is too small.
const HOOK_MIN_DURATION_MS = 60_000;

/**
 * Where to start playback for the best shot at a genuine 30-second listen.
 *
 * Returns 0 (start at the beginning) whenever the duration is unknown or
 * unusable, so every caller can pass this through unconditionally.
 *
 * Guarantees at least PLAY_THRESHOLD_MS of track remains after the offset --
 * otherwise the "start at the hook" optimization would actively make a
 * counted stream impossible, which is the exact opposite of the point.
 *
 * @param {number | null | undefined} durationMs
 * @returns {number} position to start at, in milliseconds
 */
export function hookOffsetMs(durationMs) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  if (durationMs < HOOK_MIN_DURATION_MS) return 0;

  const offset = Math.min(durationMs * HOOK_FRACTION, HOOK_MAX_OFFSET_MS);
  // Leave room for a full threshold-length listen from the offset onward.
  const latestUsable = durationMs - PLAY_THRESHOLD_MS;
  if (latestUsable <= 0) return 0;

  return Math.max(0, Math.floor(Math.min(offset, latestUsable)));
}

/**
 * Accumulates actual playing time across pauses, so "has this play reached
 * the threshold" is measured in real listening rather than track position.
 *
 * Position alone is wrong on both ends: starting at the hook means position
 * 30s may be only 5s of listening, and pausing means position stops while
 * wall-clock time doesn't. This tracks elapsed *playing* time specifically.
 *
 * Deliberately a plain state machine over an injected clock rather than
 * anything timer-owning -- the caller schedules the actual report; this just
 * answers "how much longer".
 */
export function createPlayProgress(now) {
  return {
    elapsedMs: 0,
    /** Wall-clock ms when the current playing segment began, null while paused. */
    segmentStartedAt: null,

    start(at = now()) {
      this.elapsedMs = 0;
      this.segmentStartedAt = at;
    },

    pause(at = now()) {
      if (this.segmentStartedAt === null) return;
      this.elapsedMs += Math.max(0, at - this.segmentStartedAt);
      this.segmentStartedAt = null;
    },

    resume(at = now()) {
      if (this.segmentStartedAt !== null) return; // already playing
      this.segmentStartedAt = at;
    },

    playedMs(at = now()) {
      const inFlight = this.segmentStartedAt === null ? 0 : Math.max(0, at - this.segmentStartedAt);
      return this.elapsedMs + inFlight;
    },

    /** Milliseconds of further playing needed to reach the threshold; 0 once met. */
    remainingToThresholdMs(at = now()) {
      return Math.max(0, PLAY_THRESHOLD_MS - this.playedMs(at));
    },
  };
}

// Hard ceiling on consecutive auto-advances without any user interaction.
// Continuous playback someone started and can see is ordinary music-player
// behavior; playback that runs on forever in a tab nobody is looking at is
// not, and manufacturing plays the listener never intended is stream
// manipulation under Spotify's Developer Terms -- which for a third-party
// app means losing API access entirely. 20 tracks is roughly an album and a
// half, well past any real session, and it stops a forgotten tab from
// playing all night. Any explicit tap resets the count.
export const RADIO_MAX_CONSECUTIVE = 20;

/**
 * Whether a Spotify Web Playback SDK state transition means "the track just
 * finished on its own", as opposed to a pause, a seek, or a track swap.
 *
 * The SDK has no end-of-track event. What it does emit when a track runs out
 * with nothing queued behind it is paused-at-position-0 -- which is also
 * exactly what pausing a track that never started looks like, hence the
 * requirement that we previously saw this same track actually progressing.
 *
 * Pure and exported so this heuristic -- the flakiest part of radio -- is
 * pinned by tests rather than discovered in production.
 *
 * @param {{spotifyId: string, position: number, paused: boolean} | null} previous
 * @param {{spotifyId: string, position: number, paused: boolean} | null} next
 */
export function isTrackEnd(previous, next) {
  if (!previous || !next) return false;
  // A different track now loaded is a swap, not an ending.
  if (previous.spotifyId !== next.spotifyId) return false;
  if (!next.paused || next.position !== 0) return false;
  // Only an ending if it had actually got somewhere -- otherwise this is a
  // pause at the very start, or the initial paused state before playback.
  return previous.position > 0;
}
