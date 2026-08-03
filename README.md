# Wavelengthz

Music-taste matching app. Spotify OAuth login, two swipe modes (people +
music), blended match scoring, messaging, trust & safety, and transactional
email — built on Cloudflare Workers + D1 + R2. Full design in `docs/PLAN.md`.

## Setup

1. `npm install`
2. `wrangler d1 create wavelengthz-db` — copy the returned `database_id` into `wrangler.toml`
3. `wrangler kv namespace create RATE_LIMIT_KV` — copy the returned `id` into `wrangler.toml`
4. `wrangler r2 bucket create wavelengthz-photos`
5. Apply the schema: `wrangler d1 execute wavelengthz-db --file=src/db/schema.sql`
6. Set secrets:
   ```
   wrangler secret put SPOTIFY_CLIENT_ID
   wrangler secret put SPOTIFY_CLIENT_SECRET
   wrangler secret put TOKEN_ENCRYPTION_KEY   # 32 random bytes, base64-encoded
   wrangler secret put SEED_SECRET
   wrangler secret put R2_ACCOUNT_ID
   wrangler secret put R2_ACCESS_KEY_ID
   wrangler secret put R2_SECRET_ACCESS_KEY
   wrangler secret put RESEND_API_KEY
   wrangler secret put SENTRY_DSN
   ```
7. `npm run build:css` to build Tailwind's output before first run/deploy.
8. `wrangler dev` for local development.
9. Seed the catalog once, locally or after deploy: `curl -X POST https://<your-worker>/internal/seed -H "X-Seed-Secret: <value>"`.
10. `wrangler deploy` to ship.

## Operational checklist before real users (docs/PLAN.md §14)

- [ ] Confirm Cloudflare D1 point-in-time recovery is enabled for the production database in the dashboard — it is not on by default.
- [ ] Confirm the `wavelengthz` domain is registered (docs/PLAN.md §16).
- [ ] Have `legal/privacy-policy.md` and `legal/terms-of-service.md` reviewed by counsel and replace the draft placeholders.
- [ ] Run a Lighthouse mobile pass (performance + accessibility) against the deployed swipe UI.
- [ ] Supply real PWA icon artwork at `public/icons/icon-192.png` and `public/icons/icon-512.png`.
- [ ] Deferred from docs/PLAN.md §11: photos are served as-uploaded via `GET /photos/:id` (Task 7) without WebP/AVIF transcoding or per-breakpoint resizing. Wire up Cloudflare Images (or a `/cdn-cgi/image/` resize on the `/photos/:id` route) before real-user launch.

## Testing

`npx vitest run` — runs the full suite against `@cloudflare/vitest-pool-workers` (simulated D1/R2/KV bindings, no real Cloudflare account needed).
