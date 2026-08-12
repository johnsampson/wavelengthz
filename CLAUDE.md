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

**Before finishing any change, check the diff against `APP_SHELL`'s list** (every top-level route and `.js`/`.css` file it precaches -- currently `/`, `/app.js`, `/swipe.js`, `/settings.js`, `/nav.js`, `/auth.js`, `/history.js`, `/search.js`, `/photos.js`, `/tailwind.css`, `/manifest.json`, `/onboarding`, `/history`, `/matches`, `/match`, `/artist`, `/profile`, `/messages`, `/settings` and its four sub-pages plus their `.js` files, `/notifications`, `/groups`, `/group` -- re-check the live list in `sw.js`, since it grows). Editing the *content* of one of those routes' `.html` file, or a `.js` file it precaches, requires bumping `CACHE_NAME` (`wavelengthz-shell-vN` -> `vN+1`) in the same change, with a one-line changelog entry (matching the existing v2..vN comment block) describing what changed and why it needed the bump. A brand-new route added to `APP_SHELL` needs the bump too, or a first-time visit 404s.

Skipping this is a real, repeated failure mode in this codebase -- `sw.js`'s own v23/v24 changelog entries record it happening (v24 alone covers 7 PRs that shipped without a bump, silently invisible to every already-installed user until it was finally caught). Check this on every PR that touches `public/`, not just ones that feel "frontend-heavy" -- a one-line error-message change is exactly the kind of edit that's easy to miss.
