# Idea: Genre-based radio (cross-artist continuation)

**Status:** Shipped. The open questions below were resolved as noted; kept for the reasoning behind each choice.

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

## How the open questions were resolved

- **When it crosses:** only once the artist's own catalog is exhausted, never interleaved. The common case is then completely unchanged — someone who picked an artist keeps hearing that artist — and cross-artist play is strictly additive rather than a change to existing behavior.
- **Ordering:** by how many genres the neighbour shares with the current artist, descending, breaking ties on `rowid`. Deterministic and explainable, and a single incidental overlap ranks last rather than being treated as equivalent to a close match.
- **Listener affinity vs. neutrality:** neutral to the listener's own `user_genres`, keyed only off the current artist. Predictability matters more in a player than personalization — radio that quietly drifts toward your overall taste rather than the thing you just chose is surprising in a bad way. `user_blocked_genres` *is* honored, because a block is a hard constraint rather than a preference.
- **Visual distinction:** none for now. The player bar already shows the artist name, which changes on a cross-artist hop, so a second signal would be redundant.
