const SPOTIFY_COOLDOWN_KV_KEY = 'spotify-cooldown';
// Conservative starting guess -- roughly half of the ~30s rolling window
// implied by production Sentry reports (SpotifyRateLimitError even after 3
// retries on GET /v1/albums/{id}/tracks). Spotify's real window/threshold
// isn't documented -- tune this from observed data as it comes in.
const SPOTIFY_COOLDOWN_DEFAULT_SECONDS = 15;

// Cloudflare KV requires expirationTtl >= 60s -- longer than the intended
// cooldown (15s default, and most real Retry-After values). Floored here
// purely so the row eventually self-cleans; it is NOT the signal
// isSpotifyCoolingDown uses -- that compares the stored expiry timestamp
// (the real, possibly-shorter duration) against Date.now(), so cooldown
// correctly clears after the intended duration even though the underlying
// KV row can persist up to 60s.
const KV_MIN_EXPIRATION_TTL_SECONDS = 60;

export async function markSpotifyCooldown(kv: KVNamespace, retryAfterSeconds?: number): Promise<void> {
  const validRetryAfter =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds
      : SPOTIFY_COOLDOWN_DEFAULT_SECONDS;
  const expiresAt = Date.now() + Math.round(validRetryAfter * 1000);
  await kv.put(SPOTIFY_COOLDOWN_KV_KEY, String(expiresAt), {
    expirationTtl: Math.max(Math.ceil(validRetryAfter), KV_MIN_EXPIRATION_TTL_SECONDS),
  });
}

export async function isSpotifyCoolingDown(kv: KVNamespace): Promise<number | null> {
  const stored = await kv.get(SPOTIFY_COOLDOWN_KV_KEY);
  if (stored === null) return null;
  const remaining = Number(stored) - Date.now();
  return remaining > 0 ? remaining : null;
}

// Issue #158 (part of the 250K-users strategy discussion): a manual,
// coarser safety valve alongside the reactive cooldown above -- not a
// replacement for it. isSpotifyCoolingDown reacts to a real 429 Spotify
// already sent; this instead lets a human deliberately turn off specific
// live-fallback Spotify calls ahead of a deliberate high-traffic push,
// before any 429 has actually happened, and turn it back on once the push
// is over. See src/lib/artistTopUp.ts's topUpArtistsForUser and
// src/routes/catalog.ts's GET /api/artists/:id cold-start path for the two
// call sites that check this.
export function isLiveSpotifyFallbackDisabled(env: Env): boolean {
  return env.SPOTIFY_LIVE_FALLBACK_DISABLED === 'true';
}
