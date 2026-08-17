// The persistent, fixed-position "now playing" bar, shown above the bottom
// nav on every page that mounts it. Wraps wavelengthzPlayer.js (Premium/
// Wavelengthz Player path) and a plain open.spotify.com embed iframe (Free
// tier path) behind one shared entry point -- play(track) -- so every page
// that shows a track list hands off to this module instead of managing its
// own inline player UI. Previously duplicated ~verbatim across
// index.html's anthem chip, artist.html's track rows, and profile.html's
// three separate track lists.
//
// Module-scope state below (currentTrack/mode/sdkState) is the mechanism
// that lets "now playing" survive navigating between pages once
// public/router.js stops doing full page reloads for internal links (see
// wavelengthzPlayer.js's own comment on why it's a standalone singleton for
// exactly this reason) -- ES module imports of the same URL resolve to the
// same in-memory instance for the life of the document, so this state stays
// intact across every client-side navigation.
import { checkPlayerAvailability, playTrack, pausePlayback, resumePlayback, onStateChange } from './wavelengthzPlayer.js';
import { hookOffsetMs, createPlayProgress, PLAY_THRESHOLD_MS } from './playHeuristics.js';
import { api } from './app.js';
import { showToast, showErrorToast } from './toast.js';

// `id` is what the like button (below) swipes against -- this app's own
// catalog id when the caller has one (artist.html's rows, profile.html's
// shared/recent lists), or the raw Spotify track id for a track sourced
// straight from a user's cached Spotify "top tracks" (the anthem chip,
// profile.html's own top-tracks list, neither of which ever touches the
// tracks catalog table). Either works as a swipe target -- POST
// /api/swipe/music has no FK constraint on item_id -- a Spotify-sourced id
// just won't cascade to an artist-like/genre-affinity bump the way a
// catalog-backed one does. Only truly absent (hiding the button) if some
// future caller passes a track with neither.
let currentTrack = null; // { spotifyId, id, name, artistName, imageUrl } | null
let mode = null; // 'sdk' | 'iframe' | null -- null while currentTrack is set but availability hasn't resolved yet, or when currentTrack itself is null
let sdkState = null; // { paused, position, duration } | null -- sdk mode only

// Threshold tracking for the current SDK play (see migrations/0022). Measures
// accumulated PLAYING time, not track position: playback may start at the
// hook offset rather than 0:00, and pausing stops position while wall-clock
// time keeps running -- so position alone would answer the wrong question.
// A timer rather than the SDK's state events, because player_state_changed
// fires on transitions (play/pause/seek/track change), not on a clock, so
// waiting for an event that reports position >= threshold could wait forever
// on a track nobody touches.
let playProgress = null;
let playThresholdTimer = null;
let currentPlayId = null;
let playThresholdReported = false;

function clearPlayThresholdTimer() {
  if (playThresholdTimer !== null) {
    clearTimeout(playThresholdTimer);
    playThresholdTimer = null;
  }
}

// Fire-and-forget throughout: this is telemetry sitting behind someone
// listening to music, and must never surface an error or block playback.
function schedulePlayThreshold() {
  clearPlayThresholdTimer();
  if (playThresholdReported || !playProgress) return;
  playThresholdTimer = setTimeout(() => {
    playThresholdTimer = null;
    if (playThresholdReported || !currentPlayId) return;
    playThresholdReported = true;
    api.markPlayCounted(currentPlayId).catch(() => {});
  }, playProgress.remainingToThresholdMs());
}

function stopPlayTracking() {
  clearPlayThresholdTimer();
  playProgress = null;
  currentPlayId = null;
  playThresholdReported = false;
}

// Exported for tests only -- lets the suite observe threshold bookkeeping
// without a real SDK or a real clock.
export function _playTrackingStateForTests() {
  return { currentPlayId, playThresholdReported, playedMs: playProgress ? playProgress.playedMs() : null };
}
let sdkListenerAttached = false;
let mounted = false;

// Pure (takes `track` explicitly, doesn't read module state) so it's
// testable in isolation -- isCurrentTrack, below, is the thin page-facing
// wrapper around it.
export function trackMatches(spotifyId, track) {
  return track?.spotifyId === spotifyId;
}

// Lets any page's track-row template light up the currently-playing row
// (e.g. swap its icon to a pause glyph) from this module's state instead of
// keeping its own local "is this open" flag.
export function isCurrentTrack(spotifyId) {
  return trackMatches(spotifyId, currentTrack);
}

// Whether a live Premium connection is available determines everything
// else about how a track gets played -- pulled out as its own pure
// function (rather than inlined in play(), below) purely so it's testable
// without needing a real checkPlayerAvailability()/fetch round trip.
export function pickMode(availability) {
  return availability?.available ? 'sdk' : 'iframe';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const HEART_ICON = '<path d="M12 21C2 15 2 10 3 7L7 11L12 7L17 11L21 7C22 10 22 15 12 21Z" />';

function likeButtonHtml(currentTrack) {
  // See the module comment on `currentTrack.id` above -- in practice every
  // current call site passes one, so this only hides the button for a
  // hypothetical future caller that passes neither an id nor a fallback.
  if (!currentTrack.id) return '';
  return `
    <button
      type="button"
      data-action="like"
      aria-label="Like this track"
      class="btn-ghost h-9 w-9 shrink-0 rounded-full text-brand-400"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" class="mx-auto h-5 w-5">${HEART_ICON}</svg>
    </button>`;
}

// Marquee text wrapper -- overflow:hidden + nowrap with no ellipsis (see
// applyMarquee, below, for why: text-overflow:ellipsis doesn't play well
// with an animated transform on the same element, so this intentionally
// never shows "..." -- it either fits and sits still, or doesn't fit and
// scrolls to reveal the rest instead of truncating it away). data-marquee
// is how applyMarquee finds these after the innerHTML swap below.
//
// The literal space before `${extraClass...}` matters, not just style: like
// index.html's own @source comment in styles.css describes, Tailwind v4's
// content scanner extracts class candidates by splitting the raw source
// text on whitespace/quotes -- `whitespace-nowrap${extraClass` with no
// space between them reads as one unmatched token to the scanner, so
// `.whitespace-nowrap` silently never made it into the built CSS the first
// time this was written (confirmed by grepping tailwind.css -- verify the
// same way after touching this line again).
function marqueeSpan(text, extraClass) {
  return `<span data-marquee class="block overflow-hidden whitespace-nowrap ${extraClass || ''}"><span data-marquee-text class="inline-block">${text}</span></span>`;
}

// Pure string-builder (mirrors nav.js's renderNavHtml/renderHeaderHtml) so
// the chrome's markup is unit-testable independent of any DOM/fetch side
// effects. `name`/`artistName`/`imageUrl` ultimately come from Spotify's
// own catalog data by way of this app's backend -- escaped here since this
// is raw innerHTML construction, unlike Alpine's x-text/:src bindings
// elsewhere in this app, which escape by construction.
export function renderPlayerChromeHtml(state) {
  const { currentTrack, mode, sdkState } = state;
  if (!currentTrack) return '';

  const name = escapeHtml(currentTrack.name ?? '');
  const artistName = currentTrack.artistName ? escapeHtml(currentTrack.artistName) : '';
  const imageUrl = currentTrack.imageUrl ?? '';
  const closeButton = `
    <button type="button" data-action="hide" aria-label="Close player" class="btn-ghost h-9 w-9 shrink-0 rounded-full text-lg">✕</button>`;
  const likeButton = likeButtonHtml(currentTrack);
  const textStack = `
    <div class="min-w-0 flex-1">
      ${marqueeSpan(name, 'text-sm font-medium text-neutral-100')}
      ${artistName ? marqueeSpan(artistName, 'text-xs text-neutral-400') : ''}
    </div>`;

  // mode === null: availability hasn't resolved yet (a brief window right
  // after play() is tapped) -- deliberately no play/pause control and no
  // "Basic player" badge here, since showing either would mean picking one
  // that's likely wrong and then immediately swapping it a beat later. Art
  // + name + close is the only thing safe to commit to this early.
  if (mode === null) {
    return `
      <div class="mx-auto flex w-full max-w-md items-center gap-3 p-4">
        <img src="${imageUrl}" alt="" class="h-14 w-14 shrink-0 rounded object-cover ring-1 ring-white/10" />
        ${textStack}
        ${closeButton}
      </div>`;
  }

  if (mode === 'sdk') {
    const paused = !sdkState || sdkState.paused;
    const pct = !sdkState || !sdkState.duration ? 0 : (sdkState.position / sdkState.duration) * 100;
    return `
      <div class="mx-auto flex w-full max-w-md items-center gap-3 p-4">
        <img src="${imageUrl}" alt="" class="h-14 w-14 shrink-0 rounded object-cover ring-1 ring-white/10" />
        <div class="min-w-0 flex-1">
          ${marqueeSpan(name, 'text-sm font-medium text-neutral-100')}
          ${artistName ? marqueeSpan(artistName, 'text-xs text-neutral-400') : ''}
          <div class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div class="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500" style="width:${pct}%"></div>
          </div>
        </div>
        ${likeButton}
        <button
          type="button"
          data-action="toggle"
          aria-label="${paused ? 'Play' : 'Pause'}"
          class="btn-primary h-9 w-9 shrink-0 rounded-full p-0"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" class="mx-auto h-4 w-4">${
            paused ? '<path d="M8 5v14l11-7z" />' : '<path d="M7 5h4v14H7zM13 5h4v14h-4z" />'
          }</svg>
        </button>
        ${closeButton}
      </div>`;
  }

  // iframe mode: the embed's own controls handle play/pause, and this app
  // has no way to observe its playback state -- same reasoning the old
  // per-page "Basic player" fallback badge already documented, just
  // relocated here.
  return `
    <div class="mx-auto flex w-full max-w-md items-center gap-3 p-4">
      <img src="${imageUrl}" alt="" class="h-14 w-14 shrink-0 rounded object-cover ring-1 ring-white/10" />
      <div class="min-w-0 flex-1">
        <span class="block text-[10px] font-semibold tracking-wide text-amber-400 uppercase">Basic player</span>
        ${marqueeSpan(name, 'text-sm font-medium text-neutral-100')}
        ${artistName ? marqueeSpan(artistName, 'text-xs text-neutral-400') : ''}
      </div>
      ${likeButton}
      ${closeButton}
    </div>`;
}

// Scrolls a marquee span's text left-to-right only when it's actually
// truncated (scrollWidth > clientWidth) -- static text just sits still, no
// animation applied. text-overflow:ellipsis is deliberately never used on
// these (see marqueeSpan's comment): an animated transform on an
// ellipsis-truncated element renders inconsistently across browsers, so the
// wrapper is plain overflow:hidden and the animation itself is what reveals
// the rest of the text over time.
function applyMarquee(el) {
  if (!el) return;
  const inner = el.querySelector('[data-marquee-text]');
  if (!inner) return;
  const overflow = inner.scrollWidth - el.clientWidth;
  if (overflow <= 1) return; // fits -- leave static
  el.style.setProperty('--wl-marquee-distance', `-${overflow}px`);
  // Roughly constant scroll speed regardless of text length, with a floor
  // so even a barely-overflowing title still holds still long enough to
  // read before it moves.
  el.style.setProperty('--wl-marquee-duration', `${Math.max(4, overflow / 30)}s`);
  el.classList.add('wl-marquee-scrolling');
}

function renderChrome() {
  const root = document.getElementById('wl-player-chrome');
  if (!root) return;
  root.innerHTML = renderPlayerChromeHtml({ currentTrack, mode, sdkState });
  // Overflow can only be measured once the new markup has real layout, so
  // this runs as a follow-up pass over whatever marquee wrappers just got
  // inserted, not as part of the string built above.
  root.querySelectorAll('[data-marquee]').forEach(applyMarquee);
  // Consumed by the .pb-app/.mb-app utility classes (public/styles.css) so
  // every page's bottom clearance adjusts automatically without the page
  // (or the router) needing to know or care whether the bar is currently
  // showing, and which of its three heights (loading/sdk/iframe) it's
  // showing at.
  document.documentElement.style.setProperty(
    '--wl-player-h',
    !currentTrack ? '0px' : mode === 'iframe' ? '104px' : '80px'
  );
}

// The only place the iframe is created/replaced -- Spotify's embed exposes
// no JS API to redirect an existing iframe to a different track, so a new
// track selection is the one legitimate reason to destroy and recreate it.
// Built via createElement + property assignment rather than an innerHTML
// string (unlike renderChrome above) so a track id never passes through
// HTML parsing at all.
function showIframe(spotifyId) {
  const host = document.getElementById('wl-player-iframe-host');
  if (!host) return;
  host.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = `https://open.spotify.com/embed/track/${spotifyId}?theme=0&autoplay=1`;
  iframe.width = '100%';
  iframe.height = '80';
  iframe.frameBorder = '0';
  iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
  iframe.loading = 'lazy';
  iframe.className = 'mx-auto max-w-md rounded-xl px-3 pb-3';
  host.appendChild(iframe);
  host.classList.remove('hidden');
}

function hideIframe() {
  const host = document.getElementById('wl-player-iframe-host');
  if (!host) return;
  host.classList.add('hidden');
  host.innerHTML = '';
}

// The one entry point every page's track row calls -- explicit-tap-only
// takeover: arriving at a page (or navigating to a different one via the
// router) never calls this on its own, only a real click handler does, and
// nothing about navigating away from a page stops whatever's already
// playing here either.
export async function play(track) {
  // Whatever was playing is over -- if it never reached the threshold, that
  // stays recorded as an uncounted play, which is exactly the signal wanted.
  stopPlayTracking();
  currentTrack = track;
  mode = null; // renders the neutral loading state below, not a guess at sdk/iframe
  sdkState = null;
  renderChrome();

  const availability = await checkPlayerAvailability();
  let resolvedMode = pickMode(availability);

  if (resolvedMode === 'sdk') {
    // Start at the hook rather than 0:00 -- most songs open on an intro, so
    // 0:00 puts the least compelling part of the track in exactly the first
    // 30 seconds that decide whether the stream counts. Falls back to 0 for
    // an unknown or too-short duration.
    const startPositionMs = hookOffsetMs(track.durationMs);
    const started = await playTrack(track.spotifyId, { positionMs: startPositionMs });
    if (started) {
      mode = 'sdk';
      hideIframe();

      playProgress = createPlayProgress(() => Date.now());
      playProgress.start();
      playThresholdReported = false;
      schedulePlayThreshold();
      // Recorded after playback actually started, so an attempt that failed
      // never lands in the denominator. Fire-and-forget: no playId simply
      // means this one play goes unmeasured.
      api
        .recordPlay({ spotifyTrackId: track.spotifyId, trackId: track.id ?? null, startPositionMs })
        .then((res) => {
          currentPlayId = res?.playId ?? null;
        })
        .catch(() => {});

      if (!sdkListenerAttached) {
        sdkListenerAttached = true;
        onStateChange((state) => {
          if (!currentTrack || !state) return;
          if (state.track_window?.current_track?.id !== currentTrack.spotifyId) return;
          const wasPaused = !sdkState || sdkState.paused;
          sdkState = { paused: state.paused, position: state.position, duration: state.duration };
          // Keep accumulated playing time honest across pause/resume, and
          // re-arm the timer for whatever is still owed.
          if (playProgress) {
            if (state.paused) {
              playProgress.pause();
              clearPlayThresholdTimer();
            } else if (wasPaused) {
              playProgress.resume();
              schedulePlayThreshold();
            }
          }
          renderChrome();
        });
      }
      renderChrome();
      return;
    }
    // Failed at the actual play call despite passing the availability
    // check (a transient Spotify/network hiccup, most likely) -- degrade
    // to the iframe instead of leaving the bar stuck on a player that
    // never starts, same fallback the old per-page players already had.
    resolvedMode = 'iframe';
  }

  mode = 'iframe';
  showIframe(track.spotifyId);
  renderChrome();
}

// SDK-mode only -- the iframe's own embedded controls handle play/pause
// for the Free-tier path, so this is a no-op there.
export async function togglePlayPause() {
  if (mode !== 'sdk') return;
  if (!sdkState || sdkState.paused) await resumePlayback();
  else await pausePlayback();
}

// Right-swipes the currently playing track the same way every other track
// row's Like button does (POST /api/swipe/music) -- a no-op if there's no
// internal id to swipe against (renderPlayerChromeHtml already hides the
// button in that case, but this guards direct callers too).
export async function like() {
  if (!currentTrack?.id) return;
  try {
    await api.swipe('music', { item_type: 'track', item_id: currentTrack.id, direction: 'right' });
    showToast({ message: 'Liked', icon: '❤️' });
  } catch (e) {
    showErrorToast('Could not like that track. Please try again.');
  }
}

// Explicit close only -- never called implicitly by navigation or by
// selecting a different track (play() above handles takeover on its own).
export async function hide() {
  if (mode === 'sdk') await pausePlayback();
  currentTrack = null;
  mode = null;
  sdkState = null;
  stopPlayTracking();
  hideIframe();
  renderChrome();
}

// Called once, at boot, from every page's bootstrap script -- guarded like
// nav.js's pollTimer so it stays a no-op on repeat calls (relevant since
// the router re-runs each destination page's bootstrap on every
// navigation). Deliberately never re-mounts: the bar's content is
// route-independent, so nothing about switching pages should ever touch
// #wl-player-root.
export function mountPlayerBar() {
  if (mounted) return;
  mounted = true;
  const chromeRoot = document.getElementById('wl-player-chrome');
  if (!chromeRoot) return;
  chromeRoot.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'toggle') togglePlayPause();
    else if (action === 'hide') hide();
    else if (action === 'like') like();
  });
  renderChrome();
}

// Test-only: lets like()'s tests exercise its two branches (a real
// currentTrack.id present vs. not) without going through play(), which
// touches `document` and this test pool has none. Not called anywhere
// outside test/public/playerBar.test.ts.
export function _setCurrentTrackForTests(track) {
  currentTrack = track;
}

// Test-only: mirrors wavelengthzPlayer.js's own _resetForTests -- this
// module's state is a deliberate page-lifetime (soon: session-lifetime)
// singleton, which would otherwise leak between independent test cases
// sharing this module instance. Not called anywhere outside
// test/public/playerBar.test.ts.
export function _resetForTests() {
  currentTrack = null;
  mode = null;
  sdkState = null;
  stopPlayTracking();
  sdkListenerAttached = false;
  mounted = false;
}
