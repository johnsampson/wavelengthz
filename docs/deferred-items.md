# Deferred items and known accepted limitations

A live register of things consciously **decided not to do yet**, as opposed to things nobody has thought about. Two categories:

1. **Deferred** — someone said "later" about a specific piece of work.
2. **Accepted limitations** — the system genuinely behaves this way, the reason is understood, and it isn't a bug to be re-reported.

The running feature backlog lives in GitHub issues (#2, #4, #72). This file is for the things that would otherwise get silently forgotten or repeatedly rediscovered.

---

## Deferred work

### PWA app icon is a placeholder

**Owner decision:** *"Just use the original I sent for now. I'll swap it later."*

`public/icons/icon-180.png`, `icon-192.png`, and `icon-512.png` are the supplied original, padded onto a solid background so iOS doesn't composite it onto black. The plumbing around them is finished and correct:

- `manifest.json` references 192/512; every page carries `<link rel="apple-touch-icon" href="/icons/icon-180.png">`.
- `/manifest.json` and the three icon paths are in `SITE_BASIC_AUTH_EXEMPT_PATHS` (`src/index.ts`) — **required**, because OS-level icon fetches never carry cached credentials, which is why the icon silently failed to install before.

**Swapping the artwork is a drop-in file replacement.** No code change. The only thing to remember is a `CACHE_NAME` bump in `public/sw.js` if the icons are ever added to `APP_SHELL` (they are not today).

Tracked in issue #72 as *"The logo we supplied is still not loading the main app logo on a PWA on my apple device"* — the loading problem is fixed; the artwork is what's still pending.

### Daily-drop prompt pressure-test against the real catalog

Planned but never run: pull genre and artist distribution out of production D1 and check which of the ten launch prompts the current user base could realistically answer, versus which assume a listening history nobody there has.

Blocked at the time on Cloudflare credentials in the session, with local D1 being an empty scratch DB. See `docs/superpowers/specs/2026-08-17-idea-daily-drop.md`.

### Player: seek to a clicked position

From issue #72: *"In the player — can we traverse to a time in the song, skipping to the time clicked?"*

Not started. Worth noting it's adjacent to the radio end-detection work in PR #98: `playerBar.js` already tracks `sdkState.position` / `.duration`, and the radio advance timer is re-based on every state change — so a seek would need to re-arm it (which it already does correctly, since `scheduleRadioAdvance` runs off whatever position the SDK reports after the seek).

### Artist view: liked songs sorted to the top

From issue #72, with an explicit note that it should be *"setup so we can cache it properly later."* Not started. Relevant because `GET /api/artists/:id` currently orders by `rowid` and that ordering is depended on by radio (`GET /api/tracks/:id/radio` deliberately matches it).

---

## Accepted limitations

These are correct behavior, understood and deliberate. Re-reporting them as bugs wastes a cycle.

### Radio is Premium-only

The Free-tier path is an `open.spotify.com/embed` iframe, which exposes **no JS API**. There is no way to detect a track ending inside it and nothing to chain. Radio (PR #96/#98) is a Premium behavior by necessity, not by choice.

### The first play on a freshly loaded document needs a real click

Browser autoplay-with-sound unlocks per *document*, on a genuine user gesture. Because the router does client-side navigation without full reloads, that unlock then persists across every internal navigation for the life of the document — so every `play()` after the first autoplays cleanly from any page.

A hard refresh is a genuinely new document, and nothing client-side can auto-resume across it. This also matches the deliberate product rule that arriving at a page never starts playback.

### Spotify Development Mode restrictions

Fully documented in `docs/spotify-extended-quota.md`. The short version: 5-user cap for user-authenticated flows, and several endpoints removed outright — `/v1/recommendations`, `/v1/artists/{id}/related-artists`, artist top-tracks, and the batch `/v1/tracks?ids=`.

Several ideas in `docs/superpowers/specs/` are shaped around these absences rather than blocked by them; genre radio is the clearest example.

### The service-worker cache is first-and-final

`public/sw.js`'s fetch handler is cache-first with **no revalidation**. Once a route or script is precached under `CACHE_NAME`, an already-installed user keeps that exact copy forever until `CACHE_NAME` itself changes.

This is by design, and `CLAUDE.md` documents it as a repeated real-world failure mode — v24's changelog entry alone covers 7 PRs that shipped invisible to every installed user. **Any change to a precached file requires a `CACHE_NAME` bump in the same commit.**
