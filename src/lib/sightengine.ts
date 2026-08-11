// Image moderation (issue #36 §2). Unlike every other third-party
// integration in this codebase, this one has NOT been verified against a
// live call -- no SIGHTENGINE_API_USER/SIGHTENGINE_API_SECRET exists yet to
// test with. The request shape (endpoint, models=nudity-2.1, api_user/
// api_secret auth) and the response's `nudity.none` field are built from
// Sightengine's published documentation. Verify and adjust field names for
// real the moment real credentials are available -- do not assume this is
// correct just because it type-checks and has passing mocked tests.

const BLOCK_THRESHOLD = 0.85;
const FLAG_THRESHOLD = 0.5;

export type ModerationStatus = 'approved' | 'flagged' | 'blocked';

export interface ModerationResult {
  status: ModerationStatus;
  // null specifically means "no score exists" (moderation wasn't run at
  // all -- no credentials configured) -- distinct from a real 0 score.
  score: number | null;
}

// Pure and separate from the network call specifically so the threshold
// logic itself -- the actual judgment call issue #36 §2 specifies (auto-block
// >0.85, flag 0.5-0.85) -- is unit-testable without mocking fetch, and so
// re-tuning the thresholds later (once real scores from real photos exist to
// tune against) touches one small function, not the request/parsing code.
export function classifyNudityScore(score: number): ModerationStatus {
  if (score > BLOCK_THRESHOLD) return 'blocked';
  if (score >= FLAG_THRESHOLD) return 'flagged';
  return 'approved';
}

// No-op (treated as approved, matching today's behavior -- no moderation
// capability existed before this at all) when credentials aren't configured
// yet, same posture as checkSiteBasicAuth (src/index.ts) for its own
// optional secret pair. Throws (rather than swallowing) on an actual API
// failure once credentials ARE set -- callers should treat that differently
// (fail toward review, not toward silently approving unmoderated content),
// not have that distinction hidden from them.
export async function checkNudity(imageBytes: ArrayBuffer, contentType: string, env: Env): Promise<ModerationResult> {
  if (!env.SIGHTENGINE_API_USER || !env.SIGHTENGINE_API_SECRET) {
    return { status: 'approved', score: null };
  }

  const form = new FormData();
  form.append('media', new Blob([imageBytes], { type: contentType }), 'photo');
  form.append('models', 'nudity-2.1');
  form.append('api_user', env.SIGHTENGINE_API_USER);
  form.append('api_secret', env.SIGHTENGINE_API_SECRET);

  const res = await fetch('https://api.sightengine.com/1.0/check.json', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Sightengine check failed: ${res.status} ${await res.text()}`);

  const data = await res.json<{ nudity?: { none?: number } }>();
  const none = data.nudity?.none;
  // "none" is Sightengine's own confidence the image is clean -- 1 - none is
  // the closest single "how risky is this" proxy available from that shape.
  // An unrecognized/missing field is treated as maximally uncertain (worst
  // case, not "clean"), since silently approving on a parse miss is exactly
  // the failure mode this feature exists to avoid.
  const score = typeof none === 'number' ? 1 - none : 1;

  return { status: classifyNudityScore(score), score };
}
