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
- Also confirmed directly (not part of either announced round, but real):
  `GET /v1/tracks?ids=` -- the *batch* "Get Several Tracks" endpoint -- 403s
  too, even when passed a single id. The singular `GET /v1/tracks/{id}`
  works fine. Same pattern held for artist albums/album-tracks: the
  singular-resource endpoints stayed open while the aggregate one didn't.

**Current mechanism:** `fetchArtistTracks` (`src/lib/spotify.ts`) goes via
`GET /v1/artists/{id}/albums` -> `GET /v1/albums/{id}/tracks` -> individual
`GET /v1/tracks/{id}` calls, all id-scoped, none of them fuzzy text matching.
This replaced an earlier fallback (`GET
/v1/search?type=track&q=artist:"NAME"`, filtered to results whose `artists`
list actually contained the target id) that could come back completely
empty for a real artist -- confirmed live for "Cirez D" (Eric Prydz's alias):
the query `artist:"Cirez D"` returned 10 results, and Spotify's search index
attributed every one of them to Eric Prydz's mainline catalog, zero Cirez D
credit on any of them. The id-scoped albums/tracks path has no such ambiguity
-- costs more subrequests per artist (see `SAFE_ARTISTS_PER_RUN` in
`src/db/seed.ts`), but is actually correct.

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
2. Once approved, replace `fetchArtistTracks`'s internals in
   `src/lib/spotify.ts` with a direct call to `GET
   /v1/artists/{id}/top-tracks` -- same exported function signature, so
   none of its three callers (`src/lib/artistTopUp.ts`,
   `src/routes/catalog.ts`, `src/db/seed.ts`) need to change. This
   gets real per-market top-tracks ranking back, and collapses several
   subrequests per artist down to one.
3. The defensive artist-id filter in `fetchArtistTracks` can be dropped at
   that point (the dedicated endpoint takes an artist id directly, so
   there's no ambiguity to filter), but there's no urgency to remove it --
   it's harmless dead code until the migration actually happens.
4. Re-evaluate whether Related Artists / Recommendations are worth adding to
   match scoring now that they'd be available again.
