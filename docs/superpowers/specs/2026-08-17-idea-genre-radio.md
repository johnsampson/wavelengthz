# Idea: Genre-based radio (cross-artist continuation)

**Status:** Future idea — not yet scoped for implementation. Captured so it doesn't get lost, not a build plan.

## Where this picks up

Same-artist radio shipped in PR #96 and was fixed in PR #98: when a track ends on its own, the player rolls into the next track by the same artist. The queue comes from `GET /api/tracks/:id/radio`, which is D1-only and costs **zero Spotify calls**.

That deliberately stops at the artist boundary. This spec is the cross-artist version.

## Why the obvious approach is unavailable

Spotify removed both endpoints that would make this trivial:

- `GET /v1/recommendations` — Extended-Quota-only since November 2024
- `GET /v1/artists/{id}/related-artists` — same

Both are documented in `docs/spotify-extended-quota.md`. **There is no recommender to call.** Anything cross-artist has to be built from this app's own data.

## The shape that's actually available

The data already exists:

- `artists.genres` (JSON) and the `artist_genres` join table
- `user_genres` — per-user affinity, with `artist_count` / `track_count` / `pass_count` already maintained on every swipe by `src/routes/musicSwipes.ts`
- `user_blocked_genres` — must be honored, same as the deck's candidate query does

So a genre-radio queue is roughly: *tracks by other artists sharing this artist's dominant genre, excluding blocked genres, ordered by something better than rowid.*

**This gets better as the catalog fills.** The discovery cron (`src/lib/catalogDiscovery.ts`, `30 */6 * * *`) walks genre slices adding artists, so the pool this would draw from grows on its own.

## Constraints inherited from same-artist radio

Whatever gets built must keep these — they were load-bearing in #96 and remain so:

- **D1-only.** The whole point of the current design is that a radio session costs one small query no matter how long someone listens. A cross-artist version that phones Spotify per hop would be a serious regression.
- **`RADIO_MAX_CONSECUTIVE = 20`.** The guardrail against unattended playback manufacturing plays nobody asked for — stream manipulation under Spotify's Developer Terms, which for a third-party app means losing API access entirely.
- **Never autoplay.** Arriving anywhere in the app still starts nothing; radio only ever *continues* something the listener explicitly started.
- **Premium only.** The Free-tier embed iframe exposes no JS API, so there's no way to detect a track ending and nothing to chain.

## Open questions

- When does it cross the artist boundary — only when the artist's own tracks are exhausted, or interleaved from the start?
- Ordering. `rowid` is fine within one artist (it approximates release order) but is meaningless across artists. Genre affinity? Like count? Something area-weighted, reusing what the artist page already computes?
- Does it respect the listener's `user_genres` affinity, or stay neutral to whatever the current track's genre is? The first is more personal; the second is more predictable, and predictability may matter more in a player.
- Should a genre-radio hop be visually distinguishable in the player bar from a same-artist hop?
