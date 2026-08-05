# Database migrations

This directory is the single source of truth for the D1 schema — there is no
separate `schema.sql` anymore. `0001_baseline_schema.sql` is everything that
existed before this directory was introduced; every schema change from here
on is a new numbered file.

## Making a schema change

```
wrangler d1 migrations create wavelengthz-db <short_description>
```

This creates `NNNN_short_description.sql`. Write plain SQL in it (no
`IF NOT EXISTS` needed — each migration runs exactly once, tracked in the
`d1_migrations` table).

## Applying migrations

```
wrangler d1 migrations apply wavelengthz-db --local   # local dev DB
wrangler d1 migrations apply wavelengthz-db --remote  # production DB
```

`apply` defaults to `--local` — always state the target explicitly. Apply to
local first, confirm the app works, then apply to remote.

Never hand-run `wrangler d1 execute --command="ALTER TABLE ..."` (or
`CREATE INDEX`, etc.) against either database — it makes the change with no
migration file to review, replay on another environment, or diff in a PR.

## Tests

`test/apply-schema.ts` applies every file in this directory (via
`import.meta.glob`, sorted by filename) to build the schema for each test's
isolated D1 instance — so the tests always run against the exact same schema
migrations produce locally and in production.
