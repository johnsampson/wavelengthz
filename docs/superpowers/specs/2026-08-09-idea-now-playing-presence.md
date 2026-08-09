# Idea: Live "Now Playing" Presence

**Status:** Future idea — not yet scoped for implementation. Captured so it doesn't get lost, not a build plan.

## Concept

Surface what someone is actually listening to *right now* on their profile card, via Spotify's currently-playing endpoint — confirmed today that nothing in `src/lib/spotify.ts` calls this; it's genuinely unused.

## The Hook

Solves two problems with one feature. It's a reason to open the app throughout the day rather than once per session — an ambient, always-fresh signal instead of a static profile — and it hands every conversation a built-in opener ("wait, you're listening to that right now?"), attacking the classic dating-app cold-open problem at the same time.

## Rough Shape

- Spotify endpoint: `GET /v1/me/player/currently-playing`, user-token-scoped (not client-credentials) — unlike the endpoints Development Mode has restricted (Related Artists, Recommendations, Audio Features, batch tracks), this one hasn't been flagged as removed anywhere in this codebase's existing notes (`docs/spotify-extended-quota.md`), but that should be confirmed live before relying on it, the same way every other Spotify constraint in this codebase has been verified directly rather than assumed.
- Needs a polling or on-demand refresh strategy — this is "live" data, so caching it like today's artist/genre data (fetch once, store forever) defeats the point. Likely fetched fresh whenever a candidate card is rendered, not stored in D1 at all.
- Privacy consideration: this reveals real-time listening activity, which is a different privacy shape than the rest of the profile (static bio, static top artists) — probably wants to be an explicit opt-in toggle in Settings, not default-on.

## Open Questions

- Confirm `GET /v1/me/player/currently-playing` is actually unrestricted in Development Mode before scoping further — not yet verified against the live API.
- What shows when nothing is currently playing (Spotify closed, paused) — falls back to the existing static top-tracks display, most likely.
