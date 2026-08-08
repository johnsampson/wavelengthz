# Spotify Extended Quota Mode — why we're not on it, and what changes when we are

## Current state: Development Mode

Wavelengthz's Spotify app runs in **Development Mode**, Spotify's default tier
for any app that hasn't been approved for production. It's capped at 5
allowlisted users for user-authenticated flows (login, `/me/top/*`) and shares
a single quota across all of an account's dev apps. Catalog endpoints used via
a client-credentials token (search, artist/track lookups) aren't subject to
the 5-user cap, but are still Development Mode and subject to the endpoint
restrictions below.

## What Development Mode has lost access to

Two rounds of Spotify Web API restrictions affect this app:

- **November 2024:** Related Artists, Recommendations, Audio Features, Audio
  Analysis, Get Featured Playlists, Get Category's Playlists all became
  Extended-Quota-only for apps without existing access.
- **February 2026:** `GET /v1/artists/{id}/top-tracks` ("Get Artist's Top
  Tracks") was removed entirely for Development Mode apps -- confirmed
  directly against the live API with both a client-credentials token and a
  real user token, always a 403. No smaller result set, no partial access --
  just gone. Development Mode apps also gained restrictions on artist
  popularity scores, follower counts, and new-releases browsing as part of
  the same change.

**Current workaround:** `searchTracksByArtistName` (`src/lib/spotify.ts`)
falls back to `GET /v1/search?type=track&q=artist:"NAME"`, which is still
open in Development Mode. This is a fuzzy text search, not an exact filter,
so results are now cross-checked against the target artist's actual Spotify
id (each search result carries its own `artists` list) and anything that
doesn't match is dropped -- see the "wrong songs" fix this doc ships
alongside. It's a workaround, not parity: name search can legitimately return
fewer tracks than the real top-tracks endpoint would for an artist with a
common name, since anything ambiguous gets filtered out rather than guessed.

## Extended Quota Mode: the actual fix, once we qualify

Extended Quota Mode removes the Development Mode restrictions above (full
catalog endpoint access, no 5-user login cap, higher rate limits). As of the
current developer terms, applying requires:

- An **approved organization**, not an individual developer account (Spotify
  stopped accepting individual applicants as of May 15, 2025)
- A legally registered, active, and launched business entity
- **250,000+ monthly active users**

Wavelengthz doesn't clear the MAU bar, and the product's growth strategy is
organic rather than paid-acquisition-driven, so this is a "revisit once real
usage numbers exist" item, not a near-term blocker to chase.

## What to do when we do qualify

1. Register/verify the organization in the Spotify Developer Dashboard and
   submit the Extended Quota Mode application.
2. Once approved, replace the `searchTracksByArtistName` fallback in
   `src/lib/spotify.ts` with a direct call to `GET
   /v1/artists/{id}/top-tracks` at all three call sites
   (`src/lib/artistTopUp.ts`, `src/routes/catalog.ts`,
   `src/db/seed.ts`) -- this gets real per-market top-tracks ranking back,
   not just "some tracks that matched a name search."
3. The artist-id filter added alongside the name-search workaround can be
   dropped at that point (the dedicated endpoint takes an artist id directly,
   so there's no ambiguity to filter), but there's no urgency to remove it --
   it's harmless dead code until the migration actually happens.
4. Re-evaluate whether Related Artists / Recommendations are worth adding to
   match scoring now that they'd be available again.
