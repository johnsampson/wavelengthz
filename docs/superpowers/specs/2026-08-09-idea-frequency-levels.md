# Idea: Frequency Levels

**Status:** Future idea — not yet scoped for implementation. Captured so it doesn't get lost, not a build plan.

## Concept

A visible rank — bronze → silver → gold → platinum "frequency levels" — based on genuine depth of use: swipes cast, matches made, how recently Spotify's been connected. Leveling up unlocks purely cosmetic flair: an animated profile ring, a rare-genre badge, a visualizer skin on your card.

## The Hook

The direct answer to "digital goods, leveling up." Status that's earned through real usage, never bought — this app stays free with no monetization, so this has to be cosmetic-only, never pay-to-win, from day one of scoping it (a paid-shortcut version of this would directly contradict that stance, not just be a "later" decision).

## Rough Shape

- Needs a small set of durable counters per user — total swipes, total matches, days since last Spotify token refresh — none of which are currently aggregated anywhere; today's tables record individual swipe/match rows but nothing rolls them up per-user.
- Level thresholds would be a named-constant table in code, matching the style of `ARTIST_PROFILE_TRACK_LIMIT`/`MAX_PHOTOS` — simple, tunable, no need for an admin-configurable system this early.
- Cosmetic unlocks need a place to live on the `users`/profile display — likely a small `unlocked_cosmetics` set, applied at render time in the same places `spotify_avatar_url`-style fields already render today.

## Open Questions

- Should the level be genuinely public (visible to others, a status signal) or private (just for the user themselves)? Public is where the "digital good" value really lives, but changes the design — it becomes something other people react to, not just a personal counter.
- Whether "days since last Spotify connection" is a fair signal to level on, or whether it unfairly penalizes people who connected once and never needed to reconnect.
