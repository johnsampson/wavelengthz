# Wavelengthz

## Database schema conventions

Adopted starting with `migrations/0010` (the `artist_genres` rename). Existing tables predate this and largely don't comply yet -- retrofitting them is tracked separately, not assumed done. Always check the actual migration for a given table rather than assuming it follows this.

- **Table names are plural, snake_case** (Rails convention) -- e.g. `artist_genres`, not `artist_genre` or `artistGenres`.
- **Every table gets its own `id TEXT PRIMARY KEY`** (a UUID), even join/association tables (e.g. `group_members`) and tables otherwise keyed by a natural key (e.g. `genres`, keyed by `genre` today). The natural or composite key becomes a `UNIQUE` constraint instead of the primary key -- it doesn't disqualify a table from also having its own `id`.
- **Every table gets `created_at INTEGER NOT NULL` and `updated_at INTEGER NOT NULL`** (epoch milliseconds, matching every existing timestamp column in this schema). `updated_at` gets touched on every `UPDATE` to that row in application code, not just set once at insert and left alone.
- Generate ids the same way the rest of this codebase already does: `crypto.randomUUID()` in application/route code; the `lower(hex(randomblob(4))) || '-' || ...` expression already used in `migrations/0002` and `migrations/0010` when a migration itself needs to generate one per existing row.
- SQLite/D1 cannot `ALTER TABLE` to change a primary key in place. Adding an `id` to a table that doesn't have one (or converting a composite/natural-key PK to a `UNIQUE` constraint) requires a rebuild: create the new table shape, copy rows across generating an id per row, drop the old table. `migrations/0010` is the reference example for this pattern.
