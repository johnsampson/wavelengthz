// The Wavelengthz Player: a thin wrapper around Spotify's Web Playback SDK,
// giving a Premium account full-track, in-page playback with no visible
// Spotify iframe -- as opposed to the read-only open.spotify.com/embed
// iframe every track list falls back to otherwise (public/artist.html,
// public/profile.html, public/index.html).
//
// Deliberately a standalone module rather than tangled into any one page's
// Alpine component: every page that shows a track imports the same few
// functions here rather than re-deriving SDK connection/token logic, and a
// future persistent cross-page player (not possible today -- this app has no
// client-side router, so a real page navigation always tears down whatever
// JS state existed) would talk to this same singleton rather than a rewrite.
//
// Every exported function here fails soft: on any error, timeout, missing
// scope, or non-Premium account, callers get `null`/`false`/`{available:
// false}` rather than a thrown exception -- the calling page always has the
// iframe fallback to render instead, and this module is the one place that
// decision gets made.
import { api } from './app.js';

const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';
// Spotify's own device-ready handshake is normally fast, but this guards
// against a CSP misconfiguration or a Spotify-side outage hanging a caller
// forever instead of falling back to the iframe within a reasonable time.
//
// Deliberately generous, not "fast": this only starts counting once loadSdk()
// has already resolved (the script itself has no timeout of its own -- a
// slow load just takes as long as it takes), so it exclusively bounds the
// handshake phase -- getOAuthToken's own round trip to this app's backend,
// plus Spotify's own device-registration negotiation. A Premium (paying)
// account on a genuinely slow-but-working connection was hitting this at the
// original 8s value and silently, permanently downgrading to the read-only
// iframe for that whole page load -- worse than just waiting a few more
// seconds, especially for exactly the users this feature exists for. Widened
// so a slow handshake has real room to actually finish; a truly broken one
// (misconfiguration/outage) still falls back, just a bit later.
export const CONNECT_TIMEOUT_MS = 15000;

let sdkLoadPromise = null;
let connectionPromise = null;
let availabilityPromise = null;

// Test-only: these promises are deliberately page-lifetime singletons in
// real use (one Connect device, one availability check per page load), which
// a real page load never needs to undo -- but that same caching would leak
// state between otherwise-independent test cases sharing this module
// instance. Not called anywhere outside test/public/wavelengthzPlayer.test.ts.
export function _resetForTests() {
  sdkLoadPromise = null;
  connectionPromise = null;
  availabilityPromise = null;
}

function loadSdk() {
  if (sdkLoadPromise) return sdkLoadPromise;
  sdkLoadPromise = new Promise((resolve, reject) => {
    if (window.Spotify) {
      resolve();
      return;
    }
    // Spotify's SDK script calls this global once it's finished loading and
    // initializing itself -- documented as the required hook, not something
    // this module invented.
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const script = document.createElement('script');
    script.src = SDK_SRC;
    script.onerror = () => reject(new Error('Failed to load the Spotify Web Playback SDK'));
    document.head.appendChild(script);
  });
  return sdkLoadPromise;
}

// Cheap, cached (once per page load) check of whether this account can use
// the SDK-backed player at all -- Premium, and already re-authorized since
// the `streaming` scope was added (src/routes/player.ts). Checking this
// first means a Free-tier account, or one on a pre-`streaming` token, never
// even attempts SDK/script setup at all.
export function checkPlayerAvailability() {
  if (!availabilityPromise) {
    availabilityPromise = api.playerToken().then(
      (res) => (res.available ? res : { available: false }),
      () => ({ available: false })
    );
  }
  return availabilityPromise;
}

// Resolves once to { player, deviceId }, or null if the SDK will never work
// this page load (ineligible account, init/auth/account error, or timeout).
// Cached: every caller on the page shares one Connect device rather than
// each track opening its own.
export function getPlayer() {
  if (!connectionPromise) {
    connectionPromise = connectPlayer();
  }
  return connectionPromise;
}

async function connectPlayer() {
  const availability = await checkPlayerAvailability();
  if (!availability.available) return null;

  try {
    await loadSdk();
  } catch (e) {
    return null;
  }

  return new Promise((resolve) => {
    const player = new window.Spotify.Player({
      name: 'Wavelengthz Player',
      getOAuthToken: async (cb) => {
        const res = await api.playerToken();
        // An empty string here is the SDK's own documented way of signaling
        // "no token" -- it surfaces as an authentication_error rather than
        // hanging, which the listener below already resolves on.
        cb(res.available ? res.accessToken : '');
      },
      volume: 1,
    });

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    player.addListener('ready', ({ device_id }) => settle({ player, deviceId: device_id }));
    // Any of these mean playback will never work this session -- a revoked
    // or downgraded account, a scope Spotify silently rejected, or a genuine
    // connectivity failure. None of them are worth surfacing to the user as
    // an error: they just mean "use the iframe instead," same as never
    // having been eligible in the first place.
    player.addListener('initialization_error', () => settle(null));
    player.addListener('authentication_error', () => settle(null));
    player.addListener('account_error', () => settle(null));

    setTimeout(() => settle(null), CONNECT_TIMEOUT_MS);

    player.connect();
  });
}

// Starts playback of one Spotify track id on this page's Connect device.
// Returns true on success, false on any failure -- callers fall back to the
// iframe embed either way, so the specific failure reason isn't surfaced.
// positionMs starts playback partway in ("the hook") rather than at 0:00 --
// see public/playHeuristics.js's hookOffsetMs for why. Spotify counts 30
// seconds of playback toward a stream regardless of where it started, so
// this doesn't affect whether a play counts, only how likely the listener is
// to stay that long.
export async function playTrack(spotifyTrackId, { positionMs = 0 } = {}) {
  const connection = await getPlayer();
  if (!connection) return false;

  const availability = await checkPlayerAvailability();
  try {
    const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${connection.deviceId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${availability.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        uris: [`spotify:track:${spotifyTrackId}`],
        ...(positionMs > 0 ? { position_ms: Math.floor(positionMs) } : {}),
      }),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// Pauses this page's Connect device, if it's the one currently playing.
// A no-op (not an error) if the player was never actually connected.
export async function pausePlayback() {
  const connection = await getPlayer();
  if (!connection) return false;
  await connection.player.pause();
  return true;
}

// Resumes from wherever playback was paused. Distinct from playTrack, which
// always restarts the given track from 0 via the Web API's /play endpoint --
// this is the SDK's own resume() instead, for a plain play/pause toggle on
// whatever track is already loaded rather than a restart.
export async function resumePlayback() {
  const connection = await getPlayer();
  if (!connection) return false;
  await connection.player.resume();
  return true;
}

// Jumps to an absolute position in whatever track is currently loaded.
//
// The SDK's own seek(), not the Web API's /seek endpoint: this device is
// already the active one, and the SDK call round-trips locally rather than
// through Spotify's HTTP API, so it doesn't spend app-wide rate limit budget
// on something a listener may do repeatedly while scrubbing.
export async function seekTo(positionMs) {
  const connection = await getPlayer();
  if (!connection) return false;
  await connection.player.seek(Math.max(0, Math.floor(positionMs)));
  return true;
}

// Subscribes to Spotify's own player_state_changed event -- position,
// duration, and paused/playing state for whatever this device is currently
// playing. A no-op if the player never connected; callers that only care
// about play/pause (not a live progress bar) can ignore this entirely.
export async function onStateChange(callback) {
  const connection = await getPlayer();
  if (!connection) return;
  connection.player.addListener('player_state_changed', callback);
}
