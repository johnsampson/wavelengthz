# Invite-Only Signup Gate, Gender-Balanced — Design

**Status:** Draft, awaiting review.

## Goal

Clubhouse's launch mechanic, adapted to a dating app's actual cold-start problem: invite-only signup, each member gets a small, fixed number of codes to hand out — but a code a **male** member sends can only be redeemed by a **female** signup, and vice versa. Every invite, from either side, structurally pulls in the gender the app has less of. This replaces open signup with controlled, self-balancing growth, and gives every member a reason to recruit (their own invites are the only way anyone gets in).

This is a narrower, simpler mechanic than a general referral/waitlist system — no queue positions, no lottery, just: you have codes, they only work one way, use them on people you actually want here.

## Current State (verified directly against the code)

- **No invite/waitlist concept exists at all today** — signup is fully open via OAuth. `src/routes/auth.ts`: a brand-new `users` row is created on `/callback` (Spotify, `:311-319`) or `/callback/google` (`:156-157`) the moment someone logs in with no matching `auth_identities` row. Only `id, spotify_id, email, created_at, updated_at` are set at that point.
- **`gender` isn't known at signup time.** It's set for the first time during onboarding, `POST /api/onboarding` (`src/routes/onboarding.ts`), validated against a fixed `GENDER_OPTIONS = {'male','female'}` (`:23`), required before `onboarded_at` gets set. This matters: any gender-matching enforcement has to either happen before OAuth starts (self-attested) or wait until onboarding (adds a rejection/deadlock case) — see the design decision below.
- **There's already a site-wide gate**, but it's a blunt instrument: `checkSiteBasicAuth()` (`src/index.ts:115-131`) is a single shared HTTP Basic Auth credential pair, no-op unless both `SITE_BASIC_AUTH_USER`/`SITE_BASIC_AUTH_PASSWORD` are set, checked on literally every request before routing. This is today's "nobody gets in" pre-launch gate. The invite system below is what replaces it with "some people get in, on purpose" for real launch — the two aren't meant to coexist long-term.
- No existing count-limited per-user resource uses a dedicated budget column — the closest precedent (`MAX_PHOTOS`, `src/routes/photos.ts:6`; `MAX_GROUP_MEMBERS`, `src/routes/groups.ts:13`) is a live `COUNT(*)` check at write time, not a stored balance. Invite codes are simpler than either: each code is a row, "how many left" is just `COUNT(*) WHERE created_by_user_id = ? AND redeemed_by_user_id IS NULL`.

## Design Decision: Self-Attested Gender, Not Server-Enforced

The code's target gender is shown plainly on the landing page ("You've been invited to join as a woman") **before** OAuth starts, and taken on trust from there — it is *not* re-checked against whatever gender the person later picks in onboarding.

The alternative — re-validating at onboarding time — creates a real dead end: by then the code is already consumed and the account already exists, so a mismatch means either building a "return the code, try again" flow or leaving someone stuck with an account they can't finish setting up. Trusting the self-attestation avoids that entirely, and it's consistent with a call already made in this codebase: the Google Sign-On design treats a provider's claimed email as trustworthy without independent verification, for the same reason — some trust boundary has to exist somewhere, and re-verifying everything server-side isn't free. A small amount of dishonest redemption is a much smaller problem than a deadlocked signup flow.

## Data Model

New table:

```sql
CREATE TABLE invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                    -- short, shareable, e.g. 8 chars, excludes ambiguous 0/O/1/I
  created_by_user_id TEXT REFERENCES users(id), -- NULL for system/admin-issued founding codes
  target_gender TEXT,                            -- 'male' | 'female' | NULL (NULL = admin code, either gender)
  redeemed_by_user_id TEXT REFERENCES users(id),
  redeemed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_invite_codes_code ON invite_codes(code);
CREATE INDEX idx_invite_codes_created_by ON invite_codes(created_by_user_id);
```

`users` gains one nullable column: `invited_by_code_id TEXT REFERENCES invite_codes(id)` — recorded at signup, mainly for the "who did I bring in" display in Settings later.

## Redemption Flow

1. **`GET /join?code=XYZ`** (new, static page + a small public API) — the landing page before any OAuth happens. `GET /api/invites/:code` (public, no session) returns `{ valid, inviterName?, targetGender? }` — never the inviter's email or any other PII, just a display name. Page shows "**Jordan** invited you to join Wavelengthz as a **woman**" with a plain-language confirmation ("Continue" implies yes) rather than a checkbox — the framing itself *is* the self-attestation, no extra UI needed.
2. Continuing sets a short-lived `wl_invite_code` cookie (httpOnly, `Max-Age` in the same range as the existing `wl_oauth_state`/`wl_oauth_intent` cookies, `src/routes/auth.ts`), then shows today's `public/login.html` provider choice unchanged.
3. **`/callback` and `/callback/google`, new-user branch only** (existing users logging back in are never gated — this only governs first-time signup): when `env.INVITE_ONLY` is set, require a valid `wl_invite_code` cookie. Claim it atomically —
   ```sql
   UPDATE invite_codes SET redeemed_by_user_id = ?, redeemed_at = ?
   WHERE code = ? AND redeemed_by_user_id IS NULL
   ```
   — and check exactly one row changed, closing the race where two people redeem the same code at once. No cookie, invalid code, or a claim that changes zero rows → do **not** create the user; redirect to `/join?error=invalid_code` instead. A successful claim proceeds with account creation exactly as today, plus `invited_by_code_id` set to the claimed code's id. The cookie is cleared either way.
4. **Onboarding is unchanged** — no new validation added there, per the design decision above.
5. **On first-ever onboarding completion** (`onboarded_at` transitioning from `NULL`, `src/routes/onboarding.ts`): grant `INVITE_CODES_PER_MEMBER` (start at 2, Clubhouse's number) new `invite_codes` rows, `created_by_user_id` = self, `target_gender` = the *opposite* of the gender they just declared. This is the entire self-balancing mechanism — it needs no other logic anywhere else in the app.
6. **Settings → "Your Invites"** (new panel, alongside the existing settings sections): shareable `wavelengthz.com/join?code=XYZ` links for unredeemed codes, and who redeemed the rest (display name only) — mirrors Clubhouse showing "people you invited."
7. **Founding codes**: a new admin endpoint, `POST /api/admin/invites/generate` (`{ count, targetGender }`), gated by `SEED_SECRET` matching the existing `src/db/seed.ts` admin-trigger convention. `created_by_user_id` stays `NULL`. This is how the very first cohort gets seeded before any member exists to invite anyone — and the lever for manually correcting gender balance early on if it drifts (issue more of whichever `targetGender` is running short).

## Config

- `INVITE_ONLY` (`wrangler.toml` `[vars]`, string flag) — off by default, matching the existing "no-op when unset" treatment `checkSiteBasicAuth` already uses. Intended to flip on at the same moment `SITE_BASIC_AUTH_*` comes off — handing off from "nobody in" to "invite-gated public in," not running both at once indefinitely.
- `INVITE_CODES_PER_MEMBER` — a named constant in code (style match: `ARTIST_PROFILE_TRACK_LIMIT`, `MAX_PHOTOS`), not an env var — this is a product tuning knob, not an environment-specific secret.

## What's Deliberately Out of Scope Here

- **No expiry or reclaim** for a code that's claimed (account created) but never followed through to a completed onboarding. Treated as an accepted loss, same spirit as other small edge cases already tolerated elsewhere in this codebase (e.g. the reactivate-by-email path) — not worth a cleanup job for what should be a rare case.
- **No queue, no lottery, no live position counter.** Those are real, separate ideas (covered elsewhere) but they're about *making people want in*; this mechanic is specifically about *who gets to invite whom*, and mixing the two would obscure which part is actually doing the gender-balancing work.
- **Clubhouse's live audio "rooms"** aren't part of this design — the invite-only shape is the part of Clubhouse's launch actually being borrowed here, not the room feature, which doesn't map onto a swipe-based dating product.

## Open Questions

- `INVITE_CODES_PER_MEMBER = 2` is a starting guess (Clubhouse's number, for an unrelated product) — worth revisiting once there's a real sense of how fast the two genders are actually balancing in practice.
- Whether a redeemed code's inviter should get any signal beyond "they joined" (e.g. is this a comment thread trigger, a notification) is left for a follow-up decision, not blocking this design.
