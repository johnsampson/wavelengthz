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
// that will let "now playing" survive navigating between pages once a
// client-side router stops doing full page reloads for internal links (see
// wavelengthzPlayer.js's own comment on why it's a standalone singleton for
// exactly this reason) -- ES module imports of the same URL resolve to the
// same in-memory instance for the life of the document, so this state is
// already "session-persistent" the moment nothing tears the document down.
// Until the router exists, mounting this on every page that shows tracks is
// still a real improvement on its own: one fixed bar instead of 5
// duplicated inline players, and playback survives switching between tracks
// on the SAME page the exact way it always did.
import { checkPlayerAvailability, playTrack, pausePlayback, resumePlayback, onStateChange } from './wavelengthzPlayer.js';

let currentTrack = null; // { spotifyId, name, imageUrl } | null
let mode = null; // 'sdk' | 'iframe' | null -- null only when currentTrack is null too
let sdkState = null; // { paused, position, duration } | null -- sdk mode only
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

// Pure string-builder (mirrors nav.js's renderNavHtml/renderHeaderHtml) so
// the chrome's markup is unit-testable independent of any DOM/fetch side
// effects. `name`/`imageUrl` ultimately come from Spotify's own catalog
// data by way of this app's backend -- escaped here since this is raw
// innerHTML construction, unlike Alpine's x-text/:src bindings elsewhere in
// this app, which escape by construction.
export function renderPlayerChromeHtml(state) {
  const { currentTrack, mode, sdkState } = state;
  if (!currentTrack) return '';

  const name = escapeHtml(currentTrack.name ?? '');
  const imageUrl = currentTrack.imageUrl ?? '';
  const closeButton = `
    <button type="button" data-action="hide" aria-label="Close player" class="btn-ghost h-9 w-9 shrink-0 rounded-full text-lg">✕</button>`;

  if (mode === 'sdk') {
    const paused = !sdkState || sdkState.paused;
    const pct = !sdkState || !sdkState.duration ? 0 : (sdkState.position / sdkState.duration) * 100;
    return `
      <div class="mx-auto flex w-full max-w-md items-center gap-3 p-3">
        <img src="${imageUrl}" alt="" class="h-10 w-10 shrink-0 rounded object-cover ring-1 ring-white/10" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-neutral-100">${name}</p>
          <div class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div class="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500" style="width:${pct}%"></div>
          </div>
        </div>
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
    <div class="mx-auto flex w-full max-w-md items-center gap-3 p-3">
      <img src="${imageUrl}" alt="" class="h-10 w-10 shrink-0 rounded object-cover ring-1 ring-white/10" />
      <div class="min-w-0 flex-1">
        <span class="block text-[10px] font-semibold tracking-wide text-amber-400 uppercase">Basic player</span>
        <p class="truncate text-sm font-medium text-neutral-100">${name}</p>
      </div>
      ${closeButton}
    </div>`;
}

function renderChrome() {
  const root = document.getElementById('wl-player-chrome');
  if (!root) return;
  root.innerHTML = renderPlayerChromeHtml({ currentTrack, mode, sdkState });
  // Consumed by the .pb-app/.mb-app utility classes (public/styles.css) so
  // every page's bottom clearance adjusts automatically without the page
  // (or a future router) needing to know or care whether the bar is
  // currently showing, and which of its two heights it's showing at.
  document.documentElement.style.setProperty('--wl-player-h', !currentTrack ? '0px' : mode === 'iframe' ? '96px' : '64px');
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
// takeover: arriving at a page never calls this on its own, only a real
// click handler does.
export async function play(track) {
  currentTrack = track;
  mode = null;
  sdkState = null;
  renderChrome();

  const availability = await checkPlayerAvailability();
  let resolvedMode = pickMode(availability);

  if (resolvedMode === 'sdk') {
    const started = await playTrack(track.spotifyId);
    if (started) {
      mode = 'sdk';
      hideIframe();
      if (!sdkListenerAttached) {
        sdkListenerAttached = true;
        onStateChange((state) => {
          if (!currentTrack || !state) return;
          if (state.track_window?.current_track?.id !== currentTrack.spotifyId) return;
          sdkState = { paused: state.paused, position: state.position, duration: state.duration };
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

// Explicit close only -- never called implicitly by navigation or by
// selecting a different track (play() above handles takeover on its own).
export async function hide() {
  if (mode === 'sdk') await pausePlayback();
  currentTrack = null;
  mode = null;
  sdkState = null;
  hideIframe();
  renderChrome();
}

// Called once, at boot, from every page's bootstrap script -- guarded like
// nav.js's pollTimer so it stays a no-op on repeat calls (relevant once a
// router re-runs each destination page's bootstrap on every navigation;
// harmless today too). Deliberately never re-mounts: the bar's content is
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
  });
  renderChrome();
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
  sdkListenerAttached = false;
  mounted = false;
}
