# Idea: The Compatibility Card

**Status:** Future idea — not yet scoped for implementation. Captured so it doesn't get lost, not a build plan.

## Concept

The moment two people match, generate an auto-designed shareable image: a compatibility percentage, shared top genres, maybe a shared artist both have liked. Built to be screenshotted straight into a Story or group chat.

## The Hook

This is the highest-leverage *virality* lever of the five ideas in this batch. Spotify already proved the exact mechanic works on this exact audience — "Blend" playlist covers get shared constantly precisely because they're personal, flattering, and instantly legible without explanation. Every share here is a free ad that only makes sense on this app, shown to an audience that's already musically self-selected (a friend seeing a Wavelengthz compatibility card already listens to music the way this app cares about).

## Rough Shape

- Trigger: the moment a mutual match is created (wherever that's decided today — likely `src/routes/peopleSwipes.ts`).
- Inputs already available: `scoring.ts`'s existing `spotifyOverlap`/blended score, `genresFromRow` for both users, shared `user_genres`/top-artist overlap (`musicOverlap.ts` already computes "shared genres" for display — this would reuse that, not duplicate it).
- Rendering: needs a decision on server-side image generation (e.g. an HTML/CSS-to-image render step, since Workers can't run a headless browser directly — would need an external render service or a Workers-compatible image library) vs. a client-side canvas render the user can screenshot themselves. Client-side is far cheaper and avoids new infra; likely the right starting point.
- No new schema needed — this is a presentation layer over data that already exists.

## Open Questions

- Does this need to be opt-in (some users may not want a percentage attached to a match, or may not want their genres shown even in a shareable image)?
- Client-side canvas vs. server-rendered image is the first real technical decision if this gets picked up.
