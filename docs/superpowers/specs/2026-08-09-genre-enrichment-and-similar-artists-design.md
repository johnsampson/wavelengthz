# Genre Enrichment & Similar-Artist Recommendations — Design

**Status:** Draft, awaiting review.

## Goal

Two related gaps, one plan:

1. **Genres are frequently missing.** Every genre we have comes from Spotify's own per-artist `genres` field, and Spotify is well known to return `[]` for a large share of artists. Nothing backfills or infers a genre when that happens — it becomes `{}` in the DB and stays that way forever (`upsertArtist`, `src/lib/catalogUpsert.ts`, never re-visits an existing artist's genres).
2. **There's no similarity signal at all.** The music swipe deck (`GET /api/candidates/music`, `src/routes/musicSwipes.ts`) is pure FIFO by `created_at` — no personalization, no genre filter, nothing. Catalog growth (`artistTopUp.ts`, `seed.ts`) is genre-*keyword* search only, not artist-similarity. Spotify's own Related Artists and Recommendations endpoints are Extended-Quota-only and unavailable to this app (`docs/spotify-extended-quota.md`), so there's no path to a similarity signal through Spotify alone.

This design adds a third-party enrichment pipeline — genres and similar-artist edges, both keyed off our existing `spotify_id`s — and then reworks candidate selection to actually use it.

## Constraints Carried From Earlier Discussion

- Wavelengthz stays free — no paid API tiers, nothing that assumes revenue.
- Everything stays keyed off Spotify ids end-to-end; any third-party id is an internal bridge, never user-visible or a replacement primary key.
- Burned once already on name-based matching ambiguity (Cirez D — Spotify's *track* search attributed every result to Eric Prydz's mainline catalog, not the Cirez D alias). Any name-based resolution step in this design needs the same defensive discipline: confidence-checked, and no-match-is-fine rather than accepting a wrong guess.

## Choosing the Third-Party Source

None of the realistic options accept a Spotify id directly — every one of them needs a bridge through either an artist name or a MusicBrainz id (MBID). Compared:

| Source | Genre tags | Similar artists | Bridge needed | Notes |
|---|---|---|---|---|
| **Last.fm** | `artist.getTopTags` — rich, crowd-sourced, weighted by count | `artist.getSimilar` — weighted, name-based results | name or MBID | Free API key, ~5 req/s fair-use guideline. Both endpoints accept `mbid` directly, which is what makes the MusicBrainz bridge worth building. |
| **MusicBrainz** | Some artists carry community tags, but sparse/inconsistent | None | name (its own search API) | Best used as the *identity bridge*, not the primary genre/similarity source. Its search API returns a `score` (0-100) confidence per candidate — exactly the disambiguation signal the Cirez D lesson calls for. Strict 1 req/s rate limit, enforced. |
| **ListenBrainz** | None comparable | Real listening-behavior similarity (labs API) | MBID | More "actual similarity," less mature API surface. Good phase-2-later upgrade, not a first pick — adds a second integration for one signal when Last.fm already covers both needs. |
| **Deezer** | Genre *ids* only (album/playlist level, not an artist folksonomy) | `/artist/{id}/related` | name (Deezer's own search) | No API key needed at all, which is appealing for a free app, but weak on genre tags and still needs name-based bridging with the same ambiguity risk. |

**Recommendation: MusicBrainz as the identity bridge, Last.fm as the data source for both genres and similarity.** One bridge, one data API, and Last.fm's willingness to accept an MBID directly removes most of the repeat-ambiguity risk once the bridge is trustworthy.

## Bridge Pipeline

For an artist already in our catalog (Spotify id + name, possibly already has some Spotify genres):

1. `GET https://musicbrainz.org/ws/2/artist?query=artist:"{name}"&fmt=json` → candidates each with a `score` (0-100). Accept the top candidate only if `score` clears a threshold (start at 90, tune empirically against a sample of real catalog artists before calling this done — the same "verify against the live API, don't assume" discipline used throughout this codebase). Below threshold or no results → store no MBID, but still mark the artist as attempted (see schema below) so we don't re-hit MusicBrainz's 1 req/s-limited API on the same miss every backfill run.
2. With a confident MBID: `artist.getTopTags(mbid=...)` (Last.fm) for genre tags, `artist.getSimilar(mbid=...)` for similar artists (each result: name + `match` score 0-1, no Spotify id).
3. Each similar-artist *name* gets resolved back to a Spotify id via the existing `searchArtistsByName` (`src/lib/spotify.ts`) — lower risk than the Cirez D case (that was Spotify *track* search misattributing credit; Spotify *artist* search returns the artist directly), but still: only accept if the top result's name is a confident match, skip otherwise. A skip here is fine — it just means one fewer similar-artist edge, not a wrong one.

## Data Model

- `artists.mbid TEXT` (nullable) — cached bridge id. Resolved once, never re-resolved.
- `artists.genre_enriched_at INTEGER` (nullable, epoch ms) — set whether or not enrichment found anything. Distinguishes "never attempted" from "attempted, no confident match," so a future retry with a better heuristic is possible without guessing which artists to re-try.
- Genre storage stays the existing `genres` object-map column (`src/lib/genres.ts`) — Last.fm tags get unioned in, not stored separately. Last.fm tags are noisy (years, "seen live", "awesome," etc.) — filter to alphabetic tags, drop a small denylist of known non-genre tokens, cap to the top N by Last.fm's own `count` weight (already sorted by relevance) before merging with whatever Spotify already provided.
- New table `artist_similar`:
  ```sql
  CREATE TABLE artist_similar (
    artist_id TEXT NOT NULL REFERENCES artists(id),
    similar_artist_id TEXT NOT NULL REFERENCES artists(id),
    weight REAL NOT NULL,           -- Last.fm's match score, 0-1
    source TEXT NOT NULL,           -- 'lastfm' -- named for future sources, not because we expect one soon
    created_at INTEGER NOT NULL,
    PRIMARY KEY (artist_id, similar_artist_id)
  );
  ```
  Artist-level, not user-level — one artist's similar set is shared across every user, which is the whole efficiency win over calling a third-party API per swipe. Last.fm's similarity isn't guaranteed symmetric, so both directions get stored independently when both resolve.

## Enrichment Pipeline Mechanics

- Lives in a new `src/lib/artistEnrichment.ts`, mirroring the existing `artistTopUp.ts`/`seed.ts` pattern: an async, admin-triggered/background process, never inline on a user-facing request.
- Two entry points, matching the existing seeding shape:
  - A backfill pass over already-cataloged artists where `genre_enriched_at IS NULL` (bounded per run, same `SAFE_ARTISTS_PER_RUN`-style cap as `seed.ts`, since MusicBrainz's 1 req/s limit makes runtime scale directly with artist count — check `SELECT COUNT(*) FROM artists` before sizing the first run).
  - A hook on `upsertArtist`'s `inserted` path (same trigger point `recordCatalogGenres` already uses) so every newly-added artist gets enriched once, going forward, without a separate backfill ever being needed again.
- Rate-limit discipline is the opposite of what we just did for `fetchArtistTracks` (parallelized to cut *our own* latency) — here the constraint is a *third party's* enforced limit, so this pipeline is deliberately sequential and throttled (MusicBrainz's 1 req/s is the binding constraint; Last.fm's ~5 req/s fits underneath it for free). Worth calling out explicitly so a future reader doesn't "fix" this into parallel calls and get 503s.
- Caching is permanent, same as today's Spotify-genre behavior, but with the `genre_enriched_at` distinction above so a "no match" isn't indistinguishable from "not tried yet."

## Candidate Selection Rework

Today, `GET /api/candidates/music` (`src/routes/musicSwipes.ts`) is pure FIFO. New version blends three pools, same explicit-named-weight-constant style already used in `scoring.ts`:

1. **Similar-artist expansion** (new — the actual personalization signal): take the user's most recent N right-swiped artists, look up `artist_similar` rows for each, exclude anything already swiped, rank by `weight`. Literally "artists like ones you already liked."
2. **Genre-affinity search** (existing mechanism, unchanged): `artistTopUp.ts`'s genre-keyword search against `user_genres`. Keeps the pool from just echoing near-duplicates of pool 1 — brings in genuinely new territory within genres the user already favors.
3. **General fill** (today's FIFO, unchanged): cold-start fallback for a user with no right-swipes yet, and top-off if pools 1+2 come up short.

Suggested blend once swipe history exists: 50% similar-artist / 30% genre-search / 20% general-fill. A brand-new user with zero right-swipes has nothing to expand from, so falls back to 100% general-fill — today's behavior, unchanged, not a regression.

## Config

New secrets (`wrangler secret put`, matching `SPOTIFY_CLIENT_ID`'s treatment): `LASTFM_API_KEY`. MusicBrainz needs no key, just a compliant `User-Agent` header (its stated requirement).

## Phasing

1. **Genre enrichment** (MusicBrainz bridge + Last.fm tags, backfill + upsert hook). Ships alone; immediately improves person-to-person genre-overlap scoring (`scoring.ts` already consumes genres) even before similarity lands.
2. **Similar-artist harvesting** (Last.fm `getSimilar` → resolved to Spotify ids → `artist_similar`). Side effect: some similar artists won't be in our catalog yet, so this phase also grows the catalog somewhat — a discovery feature, not a bug, but worth flagging since it's a scope difference from phase 1.
3. **Candidate-selection rework** (`/api/candidates/music` blending). This is where users actually feel the change — phases 1-2 are invisible plumbing until this lands.
4. **Later, not now:** revisit ListenBrainz behavioral similarity, or drop this whole pipeline in favor of Spotify's own Related Artists/Recommendations if Extended Quota Mode is ever reached (`docs/spotify-extended-quota.md`); consider refreshing `music_profiles.top_genres` periodically (currently cached indefinitely) now that genre data quality is improving.

## Open Questions / Risks

- MusicBrainz's confidence threshold (90 suggested) needs tuning against real catalog artists before phase 1 is called done — same "verify against live data, don't assume" approach used throughout this codebase.
- Last.fm's ToS/attribution expectations should get a quick check before shipping — this design uses it as backend enrichment only (not user-facing "powered by Last.fm" display), which is likely fine, but not yet confirmed.
- Current catalog size is unknown — needs a quick `SELECT COUNT(*) FROM artists` before sizing the first backfill run, since MusicBrainz's 1 req/s cap makes runtime scale directly with it.
