// iOS/Android "Now Playing" integration via the Media Session API --
// without this, a playing track only ever shows up as a generic speaker/
// audio icon in Safari's status bar, Control Center, and the lock screen
// ("Can we add metadata to iPhone so it shows album metadata... currently
// it has a speaker icon"). Wired into playerBar.js's own play()/hide()/
// state-change lifecycle rather than duplicated per page, same reasoning
// as playerBar.js itself consolidating the old per-page inline players.
//
// A second, purely cosmetic piece: the artwork handed to iOS is a
// composited "half app logo / half album art" square (buildComposedArtwork
// below) rather than the bare album art. Best-effort only -- compositing
// needs to read pixel data out of the album art image via <canvas>, which
// requires Spotify's image host to serve it with CORS headers permissive
// enough for that (crossOrigin='anonymous'); if it doesn't, the canvas is
// "tainted" and toDataURL() throws. That failure (and any other -- a slow/
// broken image load) is caught and silently falls back to the bare album
// art already set synchronously below, so a CORS surprise degrades to
// "plain metadata, still miles better than a speaker icon" rather than
// breaking anything.

const HAS_MEDIA_SESSION = typeof navigator !== 'undefined' && 'mediaSession' in navigator;

// The app's own square icon -- already a solid brand-pink field with the
// wordmark centered, see public/manifest.json. Same-origin, so drawing it
// into a canvas never taints it.
const LOGO_URL = '/icons/icon-512.png';
const ARTWORK_SIZE = 512;

/**
 * Classic CSS `object-fit: cover` crop math, source-image side: given a
 * source of size (sw, sh) and a destination box of size (dw, dh), returns
 * the centered source rectangle {sx, sy, sWidth, sHeight} that, drawn to
 * fill the whole destination box, crops rather than distorts. Pure, so it's
 * testable without Image/canvas, neither of which exists in this test
 * pool's Workers runtime.
 */
export function coverCropRect(sw, sh, dw, dh) {
  const scale = Math.max(dw / sw, dh / sh);
  const sWidth = dw / scale;
  const sHeight = dh / scale;
  return { sx: (sw - sWidth) / 2, sy: (sh - sHeight) / 2, sWidth, sHeight };
}

/**
 * The MediaMetadata init this module sets immediately (compositing the
 * fancier artwork below is async) -- pure, so the title/artist/album shape
 * is testable independent of the real `MediaMetadata` constructor.
 */
export function buildMetadataInit(track, artworkSrc) {
  return {
    title: track?.name ?? '',
    artist: track?.artistName ?? '',
    album: 'Wavelengthz',
    artwork: artworkSrc ? [{ src: artworkSrc, sizes: `${ARTWORK_SIZE}x${ARTWORK_SIZE}`, type: 'image/png' }] : [],
  };
}

function loadImage(src, { crossOrigin } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

function drawCover(ctx, img, dx, dy, dw, dh) {
  const { sx, sy, sWidth, sHeight } = coverCropRect(img.naturalWidth, img.naturalHeight, dw, dh);
  ctx.drawImage(img, sx, sy, sWidth, sHeight, dx, dy, dw, dh);
}

// Best-effort only -- see the module comment above for why this can fail
// and why that's fine. Resolves to a data: URL (always same-origin/CSP-safe
// -- styles.css's CSP img-src already allow-lists data:) or rejects.
async function buildComposedArtwork(albumArtUrl) {
  const half = ARTWORK_SIZE / 2;
  const [logo, art] = await Promise.all([loadImage(LOGO_URL), loadImage(albumArtUrl, { crossOrigin: 'anonymous' })]);

  const canvas = document.createElement('canvas');
  canvas.width = ARTWORK_SIZE;
  canvas.height = ARTWORK_SIZE;
  const ctx = canvas.getContext('2d');
  drawCover(ctx, logo, 0, 0, half, ARTWORK_SIZE);
  drawCover(ctx, art, half, 0, half, ARTWORK_SIZE);
  return canvas.toDataURL('image/png');
}

/**
 * Called every time playerBar.js commits to a new track (regardless of sdk
 * vs iframe mode -- Now Playing metadata isn't mode-specific). Sets the
 * plain album-art metadata immediately, synchronously, then upgrades to the
 * composited logo/album-art artwork once (if) that finishes.
 *
 * `isStillCurrent` is checked before applying the composited upgrade so a
 * fast track change while compositing an older one is still in flight can
 * never overwrite the newer track's metadata -- the same stale-async-write
 * hazard playerBar.js's own playToken guard exists for, just for this
 * module's own async step rather than the Spotify play call.
 */
export function setNowPlayingMetadata(track, isStillCurrent) {
  if (!HAS_MEDIA_SESSION || !track) return;

  navigator.mediaSession.metadata = new MediaMetadata(buildMetadataInit(track, track.imageUrl));

  if (!track.imageUrl) return;
  buildComposedArtwork(track.imageUrl)
    .then((composedUrl) => {
      if (!isStillCurrent()) return;
      navigator.mediaSession.metadata = new MediaMetadata(buildMetadataInit(track, composedUrl));
    })
    .catch(() => {}); // plain artwork set above already stands
}

export function clearNowPlayingMetadata() {
  if (!HAS_MEDIA_SESSION) return;
  navigator.mediaSession.metadata = null;
  navigator.mediaSession.playbackState = 'none';
}

export function setPlaybackState(state) {
  if (!HAS_MEDIA_SESSION) return;
  navigator.mediaSession.playbackState = state;
}

// Called once, at boot -- action handlers are session-global, not
// per-track. Wrapped per-handler in try/catch: setActionHandler throws on
// an action a given browser doesn't support, rather than letting an
// unsupported one abort every handler after it.
export function registerMediaSessionActionHandlers(handlers) {
  if (!HAS_MEDIA_SESSION) return;
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (e) {
      // Not supported by this browser -- fine, iOS just won't offer that control.
    }
  }
}
