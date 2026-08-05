# Wavelengthz

Music-taste matching app. Spotify OAuth login, two swipe modes (people +
music), blended match scoring, messaging, trust & safety, and transactional
email — built on Cloudflare Workers + D1 + R2. Full design in `docs/PLAN.md`.

## Setup

1. `npm install`
2. `wrangler d1 create wavelengthz-db` — copy the returned `database_id` into `wrangler.toml`
3. `wrangler kv namespace create RATE_LIMIT_KV` — copy the returned `id` into `wrangler.toml`
4. `wrangler r2 bucket create wavelengthz-photos`
5. Apply the schema via migrations (`migrations/*.sql`, applied in filename
   order — see `migrations/README.md`). `wrangler d1 migrations apply`
   defaults to the **local** dev database, so the target has to be stated
   explicitly — running the local form and assuming production was updated
   is the easy mistake here:
   ```
   wrangler d1 migrations apply wavelengthz-db --local   # local dev DB
   wrangler d1 migrations apply wavelengthz-db --remote  # production DB
   ```
   Any future schema change is a new file created with
   `wrangler d1 migrations create wavelengthz-db <name>`, applied the same
   way to both targets — never a hand-run `wrangler d1 execute --command=...`
   against either database, which leaves no record of what changed or when.
6. Set secrets. All eleven are required — the list must stay in sync with the
   `Env` interface in `src/env.d.ts`. Note that `R2_BUCKET_NAME` and
   `RESEND_FROM_ADDRESS` fail *silently* when missing: photo uploads and every
   transactional email respectively just stop working, with no startup error.
   ```
   wrangler secret put SPOTIFY_CLIENT_ID
   wrangler secret put SPOTIFY_CLIENT_SECRET
   wrangler secret put TOKEN_ENCRYPTION_KEY   # 32 random bytes, base64-encoded
   wrangler secret put SEED_SECRET
   wrangler secret put R2_ACCOUNT_ID
   wrangler secret put R2_ACCESS_KEY_ID
   wrangler secret put R2_SECRET_ACCESS_KEY
   wrangler secret put R2_BUCKET_NAME         # e.g. wavelengthz-photos (must match the bucket from step 4)
   wrangler secret put RESEND_API_KEY
   wrangler secret put RESEND_FROM_ADDRESS    # verified Resend sender, e.g. matches@wavelengthz.app
   wrangler secret put SENTRY_DSN
   ```
7. `npm run build:css` to build Tailwind's output before first run/deploy.
8. `wrangler dev` for local development.
9. Seed the catalog once, locally or after deploy: `curl -X POST https://<your-worker>/internal/seed -H "X-Seed-Secret: <value>"`.
10. `wrangler deploy` to ship.

## Operational checklist before real users (docs/PLAN.md §14)

- [ ] Change `SPOTIFY_REDIRECT_URI` in `wrangler.toml` from `http://localhost:8787/callback` to the real production URL, and register that exact URL in the Spotify app dashboard — OAuth fails for every user until both sides match.
- [ ] Confirm the production schema was applied with `--remote` (step 5) — the default targets the local dev DB.
- [ ] Confirm all eleven secrets from step 6 are set in production (`wrangler secret list`); `R2_BUCKET_NAME` and `RESEND_FROM_ADDRESS` fail silently if missing.
- [ ] Confirm Cloudflare D1 point-in-time recovery is enabled for the production database in the dashboard — it is not on by default.
- [ ] Confirm the `wavelengthz` domain is registered (docs/PLAN.md §16).
- [ ] Have `legal/privacy-policy.md` and `legal/terms-of-service.md` reviewed by counsel and replace the draft placeholders.
- [ ] Run a Lighthouse mobile pass (performance + accessibility) against the deployed swipe UI.
- [ ] Supply real PWA icon artwork at `public/icons/icon-192.png` and `public/icons/icon-512.png`.
- [ ] Deferred from docs/PLAN.md §11: photos are served as-uploaded via `GET /photos/:id` (Task 7) without WebP/AVIF transcoding or per-breakpoint resizing. Wire up Cloudflare Images (or a `/cdn-cgi/image/` resize on the `/photos/:id` route) before real-user launch.

## Testing

`npx vitest run` — runs the full suite against `@cloudflare/vitest-pool-workers` (simulated D1/R2/KV bindings, no real Cloudflare account needed).
