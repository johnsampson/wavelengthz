// Twilio Verify (OTP send/check) + Lookup (line-type detection, used to
// reject VOIP numbers before an OTP is ever sent -- see isBlockedLineType).
// Same request shape as src/lib/spotify.ts's OAuth calls: HTTP Basic Auth,
// form-urlencoded bodies, throw on a non-ok response.

function basicAuthHeader(env: Env): string {
  return 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
}

export interface PhoneLookup {
  valid: boolean;
  phoneNumber: string; // E.164, as normalized by Twilio
  lineType: string | null;
}

// Twilio's Line Type Intelligence categories: "mobile", "landline", "voip",
// "personal", "tollFree", "premium", "sharedCost", "uan", "voicemail",
// "pager", "unknown". Only "voip" is blocked -- a Set, so adding another
// blocked category later is a one-line change.
const BLOCKED_LINE_TYPES = new Set(['voip']);

export function isBlockedLineType(lineType: string | null): boolean {
  return lineType !== null && BLOCKED_LINE_TYPES.has(lineType);
}

export async function lookupPhoneNumber(phoneNumber: string, env: Env): Promise<PhoneLookup> {
  const res = await fetch(
    `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phoneNumber)}?Fields=line_type_intelligence`,
    { headers: { Authorization: basicAuthHeader(env) } }
  );
  if (!res.ok) throw new Error(`Twilio lookup failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{
    valid: boolean;
    phone_number: string;
    line_type_intelligence: { type: string | null } | null;
  }>();
  return { valid: data.valid, phoneNumber: data.phone_number, lineType: data.line_type_intelligence?.type ?? null };
}

export async function startVerification(phoneNumber: string, env: Env): Promise<void> {
  const res = await fetch(`https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/Verifications`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(env), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: phoneNumber, Channel: 'sms' }),
  });
  if (!res.ok) throw new Error(`Twilio verification start failed: ${res.status} ${await res.text()}`);
}

export async function checkVerification(phoneNumber: string, code: string, env: Env): Promise<{ approved: boolean }> {
  const res = await fetch(`https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(env), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: phoneNumber, Code: code }),
  });
  // A wrong/expired code is a normal outcome, not a transport failure --
  // Twilio 404s when the underlying verification can no longer be found
  // (expired, max attempts exceeded), and returns 200 with status !==
  // 'approved' for a simple wrong code. Only a genuine server/auth error
  // should throw.
  if (res.status === 404) return { approved: false };
  if (!res.ok) throw new Error(`Twilio verification check failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ status: string }>();
  return { approved: data.status === 'approved' };
}
