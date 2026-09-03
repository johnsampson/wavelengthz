# Wavelengthz Cookie Policy

**Version 1.0 — Draft dated August 31, 2026**

> Published version: `public/cookies.html` — keep both in sync when
> editing.

Wavelengthz uses less browser storage than most sites — no third-party
advertising trackers, no cross-site cookies, and no cookie-consent banner
full of vendor toggles. Here's the complete list of what we store in your
browser and why.

## What we use

| Storage | Purpose | Type |
|---|---|---|
| `wl_session` cookie | Keeps you signed in between visits. Without it, you'd have to sign in on every page load. | Strictly necessary |
| `wl_ga_client_id` (localStorage) | A randomly-generated id (not your name or account) used to measure usage in aggregate — see our [Privacy Policy](./privacy-policy.md) §5. | Analytics |
| `wl_ga_session_id` (sessionStorage) | Same purpose as above, scoped to a single browser tab/session rather than persisted long-term. | Analytics |

That's the entire list. We don't set any advertising, cross-site tracking,
or third-party marketing cookies, and we don't run any ad network's pixel
on the site.

## Why "cookie policy" covers localStorage too

`wl_ga_client_id` and `wl_ga_session_id` are technically browser
`localStorage`/`sessionStorage` values, not cookies — but they serve the
same purpose a typical analytics cookie would, so we're describing them
here rather than drawing a technical distinction that wouldn't mean much in
practice. Notably, this also means our Google Analytics integration doesn't
load any Google script or set any Google cookie in your browser at all —
usage events are sent from our own server, not from your browser directly.

## Your choices

- **`wl_session`** can't be disabled without also disabling the ability to
  stay signed in — it's the login mechanism itself, not a tracking
  mechanism.
- **The two analytics identifiers** are cleared automatically if you clear
  your browser's site data/local storage for Wavelengthz, or you can clear
  them manually through your browser's developer tools or site-settings
  panel. Clearing them just means a new random id gets generated next time,
  which doesn't affect anything about your account.
- We don't currently respond to "Do Not Track" or Global Privacy Control
  signals as a technical opt-out, since we don't do the kind of
  cross-context behavioral advertising those signals are aimed at stopping
  in the first place.

## Changes to this policy

If what we store changes, we'll update this page and the version/date at
the top.

---

*See also: [Terms of Service](./terms-of-service.md) ·
[Privacy Policy](./privacy-policy.md)*
