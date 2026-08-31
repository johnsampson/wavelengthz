# Wavelengthz Privacy Policy

**Version 1.0 — Draft dated August 31, 2026**

> **This is a first-pass draft, not legal advice.** It has not been reviewed
> by a lawyer. It's intended to accurately describe what Wavelengthz
> actually collects and does today — required by `docs/PLAN.md` §8 and by
> Spotify's Developer Terms, which condition API access on a published
> privacy policy — not to be the final version we launch with. Have this
> reviewed by counsel before it governs real users' data, in particular
> §7 (international transfers) if Wavelengthz launches to EU users before a
> GDPR representative/DPO arrangement is in place.
>
> Published version: `public/privacy.html` — keep both in sync when editing.

## 1. Who this policy covers

This policy describes how Wavelengthz collects, uses, and shares
information about you when you use the app. "Wavelengthz," "we," and "us"
refer to the operator of the Wavelengthz service.

## 2. Information we collect

**From Spotify or Google, when you sign in.** Your name, email address,
profile photo, and (for Spotify) your top artists, top tracks, and recent
listening history — this is the basis for the music-taste matching the app
exists to do. We do not receive your Spotify or Google password; sign-in
happens entirely through their own OAuth flow.

**Information you provide directly.** Your date of birth (used once, at
signup, to confirm you're 18+ — see §8), your gender and who you're seeking,
an approximate location, profile photos you upload, your bio, and the
content of messages you send.

**Phone number**, if you choose to verify one — used only for verification
(via Twilio) and anti-abuse purposes, not shown to other users.

**Push notification subscription**, if you enable notifications — a token
identifying your device/browser, used only to deliver notifications to you.

**Usage and device information.** Standard web request metadata (IP
address, browser/device type, pages visited) collected by Cloudflare as
part of hosting the app, and product-analytics events (e.g., "you swiped,"
"you sent a message," "you answered today's Daily Drop") recorded against a
randomly-generated identifier — see §5.

## 3. How we use your information

- To create your profile and calculate music-taste and people matches.
- To show your profile to other users and let you message the people you
  match with.
- To screen uploaded photos and outgoing messages for content that violates
  our [Community Guidelines](./community-guidelines.md).
- To send transactional email (match notifications, account-related
  messages) and push notifications, where enabled.
- To verify you're a real person with a working phone number, where you
  choose to verify one.
- To detect, investigate, and act on reports of abuse, harassment, or
  policy violations.
- To measure how the app is used in aggregate, so we know what's working —
  see §5.
- To comply with legal obligations, including Spotify's own data-deletion
  requirements described in §6.

We do not use your information to show you third-party advertising, and we
do not sell your personal information to anyone.

## 4. What other users can see

Other users can see your first name, age, approximate distance from them
(never your exact location), your bio, your uploaded photos, and your
music taste (top artists/tracks/genres). Once you match with someone, they
can also see the messages you send them. We don't show your last name,
email address, phone number, or exact location to other users under any
circumstance.

## 5. Analytics and cookies

We use one essential cookie to keep you signed in — see our [Cookie
Policy](./cookies-policy.md) for the full, short list of what the app
actually stores in your browser and why (it's simpler than most: one login
cookie, no third-party ad trackers).

We also record first-party product-analytics events (e.g., swipes, matches,
messages sent) tied to a randomly-generated identifier stored in your
browser, not your name or account. When configured, these events are also
forwarded to Google Analytics 4 for aggregate usage measurement — Google
processes this data under its own privacy policy, and we don't send it
anything beyond the event name, a randomly-generated client identifier, and
whatever minimal metadata the event itself carries (e.g., which surface a
message was sent from). We do not sell this data or share it for
cross-context behavioral advertising, and under CCPA/CPRA terms, we don't
consider this a "sale" or "share" of your personal information.

## 6. How long we keep your information, and how to delete it

You can delete your account at any time from Settings. Deletion isn't
instant: your account enters a 7-day grace period (so an accidental or
impulsive deletion can be undone by signing back in), after which it's
permanently and irreversibly purged — including your photos, messages,
match history, and any Spotify/Google access tokens we held for you. This
also satisfies Spotify's own Developer Policy, which requires deleting a
user's personal data when they disconnect their account or otherwise revoke
access.

Backups that already existed before a deletion may retain your information
for a limited additional period before they, too, roll off — we don't keep
a separate, indefinite archive of deleted accounts.

## 7. Who we share information with

We share information with the following categories of service providers,
each strictly to provide the part of the app they support:

- **Spotify and Google** — for sign-in and the music-catalog/profile data
  the app is built on.
- **Resend** — to deliver transactional email (match notifications, etc.).
- **Twilio** — to send and verify phone-verification codes, if you choose
  to verify a number.
- **Sentry** — for error monitoring, so we can find and fix bugs.
- **Cloudflare** — for hosting, our database, and photo storage.
- **Google Analytics** — for aggregate product-usage measurement, as
  described in §5.

We may also disclose information if required by law, to protect the safety
of any person, to investigate violations of our Terms of Service or
Community Guidelines, or in connection with a merger, acquisition, or sale
of assets (in which case we'd tell you before your information becomes
subject to a different privacy policy).

We do not sell your personal information.

## 8. Children's privacy

Wavelengthz is not directed at, and doesn't knowingly collect information
from, anyone under 18. Account creation is blocked outright — not just
discouraged — if the date of birth you provide works out to under 18. If we
learn we've collected information from someone under 18 despite this, we'll
delete it.

## 9. International data transfers

Wavelengthz's infrastructure (Cloudflare) and several of our service
providers (§7) operate globally, which means your information may be
processed in countries other than the one you're in, including the United
States. Where required, we rely on appropriate safeguards (such as standard
contractual clauses) for these transfers.

## 10. Your rights and choices

Depending on where you live, you may have the right to access, correct,
export, or delete the personal information we hold about you, and to object
to or restrict certain processing. You can exercise most of these directly
in Settings (editing your profile, downloading isn't yet self-serve — email
us) or by deleting your account (§6). For anything else, contact us at
**connect@wavelengthz.com** and we'll respond within a reasonable time.

**California residents (CCPA/CPRA):** we don't sell or share your personal
information as those terms are defined under California law, so there's no
opt-out link to provide — but you still have the rights described above,
which you can exercise the same way.

**EU/UK residents (GDPR):** the rights above correspond to your rights of
access, rectification, erasure, restriction, and data portability under the
GDPR/UK GDPR. You also have the right to lodge a complaint with your local
data protection authority.

## 11. Security

We use industry-standard measures to protect your information, including
encryption of sensitive data (like Spotify/Google access tokens) at rest
and TLS encryption in transit. No system is perfectly secure, though, and we
can't guarantee absolute security.

## 12. Changes to this policy

We'll update the version and date at the top of this document when this
policy changes. If a change is material, we'll make a reasonable effort to
flag it in the app before it takes effect.

## 13. Contact

Questions about this policy, or a request relating to your information:
**connect@wavelengthz.com**.

---

*See also: [Terms of Service](./terms-of-service.md) ·
[Community Guidelines](./community-guidelines.md) ·
[Safety Tips](./safety-tips.md) · [Cookie Policy](./cookies-policy.md) ·
[DMCA / Copyright Policy](./dmca-policy.md)*
