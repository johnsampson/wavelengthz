# Wavelengthz

## Database schema conventions

Adopted starting with `migrations/0010` (the `artist_genres` rename) and applied to every other table in `migrations/0011`. The whole schema complies as of `0011`; any new migration is expected to keep it that way from here on.

- **Table names are plural, snake_case** (Rails convention) -- e.g. `artist_genres`, not `artist_genre` or `artistGenres`.
- **Every table gets its own `id TEXT PRIMARY KEY`** (a UUID), even join/association tables (e.g. `group_members`) and tables otherwise keyed by a natural key (e.g. `genres`, keyed by `genre` today). The natural or composite key becomes a `UNIQUE` constraint instead of the primary key -- it doesn't disqualify a table from also having its own `id`.
- **Every table gets `created_at INTEGER NOT NULL` and `updated_at INTEGER NOT NULL`** (epoch milliseconds, matching every existing timestamp column in this schema). `updated_at` gets touched on every `UPDATE` to that row in application code, not just set once at insert and left alone.
- Generate ids the same way the rest of this codebase already does: `crypto.randomUUID()` in application/route code; the `lower(hex(randomblob(4))) || '-' || ...` expression already used in `migrations/0002` and `migrations/0010` when a migration itself needs to generate one per existing row.
- SQLite/D1 cannot `ALTER TABLE` to change a primary key in place. Adding an `id` to a table that doesn't have one (or converting a composite/natural-key PK to a `UNIQUE` constraint) requires a rebuild: create the new table shape, copy rows across generating an id per row, drop the old table. `migrations/0010` is the reference example for this pattern.

## Service worker cache version (public/sw.js)

`public/sw.js`'s `fetch` handler is cache-first with no revalidation: once a route or script is precached under `CACHE_NAME`, an already-installed user keeps getting that exact cached copy forever, even after the underlying file changes on the server -- the only thing that busts it is bumping `CACHE_NAME` itself (the `activate` handler deletes every cache key that doesn't match the new name).

**Before finishing any change, check the diff against `APP_SHELL`'s list** (every top-level route and `.js`/`.css` file it precaches -- currently `/`, `/app.js`, `/swipe.js`, `/settings.js`, `/nav.js`, `/auth.js`, `/history.js`, `/search.js`, `/photos.js`, `/toast.js`, `/alpine.js`, `/playerBar.js`, `/wavelengthzPlayer.js`, `/router.js`, `/index.js`, `/artist.js`, `/personProfile.js`, `/matches.js`, `/match.js`, `/groups.js`, `/notifications.js`, `/messages.js`, `/group.js`, `/tailwind.css`, `/manifest.json`, `/onboarding`, `/history`, `/matches`, `/match`, `/artist`, `/profile`, `/messages`, `/settings` and its four sub-pages plus their `.js` files, `/notifications`, `/groups`, `/group`, `/drop` -- re-check the live list in `sw.js`, since it grows). Editing the *content* of one of those routes' `.html` file, or a `.js` file it precaches, requires bumping `CACHE_NAME` (`wavelengthz-shell-vN` -> `vN+1`) in the same change, with a one-line changelog entry (matching the existing v2..vN comment block) describing what changed and why it needed the bump. A brand-new route added to `APP_SHELL` needs the bump too, or a first-time visit 404s.

Skipping this is a real, repeated failure mode in this codebase -- `sw.js`'s own v23/v24 changelog entries record it happening (v24 alone covers 7 PRs that shipped without a bump, silently invisible to every already-installed user until it was finally caught). Check this on every PR that touches `public/`, not just ones that feel "frontend-heavy" -- a one-line error-message change is exactly the kind of edit that's easy to miss.

## DB-first: check D1 before calling Spotify

Spotify enforces its own app-wide rate limit (`src/lib/spotify.ts`'s `spotifyFetch`, `SpotifyRateLimitError`) that has nothing to do with this app's own rate limiter (`src/index.ts`) -- it's been the root cause of multiple production incidents in this codebase (artist-loading 429s, "countless calls to `v1/tracks/{id}`"). Catalog data (artist/track name, art, genres, preview URL) is immutable once fetched, so **any code path about to call a Spotify endpoint for an artist or track must check whether it's already in D1 first, and skip the call entirely if so** -- not just cache the live result afterward.

Every artist/track-fetching entry point in this codebase already follows this:

- `GET /api/artists/:id` (`src/routes/catalog.ts`) checks `tracks` for this artist before touching the KV cache or Spotify at all; the access token itself is fetched lazily, only once something downstream actually needs a live call.
- `POST /api/artists` / `POST /api/tracks` (`src/routes/catalog.ts`) check `artists`/`tracks` by `spotify_id` and short-circuit before ever resolving a token or calling Spotify.
- `src/lib/artistTopUp.ts`, `src/db/seed.ts`, and `src/db/catalogRefresh.ts` each check `SELECT 1 FROM artists WHERE spotify_id = ?` before fetching that artist's tracks/details.
- `GET /api/me` (`src/routes/me.ts`) checks `music_profiles` before fetching a user's top artists/tracks.

**New code that fetches an artist or track from Spotify needs the same check** -- query D1 by `spotify_id` (or the relevant lookup) before calling any of `fetchArtistById`/`fetchArtistTracks`/`fetchArtistTracksQuick`/`fetchTrackById`, and skip the call (and the token fetch that precedes it) entirely on a hit. The two live-search endpoints (`GET /api/artists/search`, `GET /api/tracks/search`) are the deliberate exception -- a search has to ask Spotify for results this app doesn't have yet, so DB-first there means merging in and tagging already-cataloged local matches, not skipping the search itself.
