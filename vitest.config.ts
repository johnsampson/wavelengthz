import { defineConfig } from 'vitest/config';
import { cloudflareTest, cloudflarePool } from '@cloudflare/vitest-pool-workers';

const wranglerOptions = { wrangler: { configPath: './wrangler.toml', environment: 'test' } };

export default defineConfig({
  plugins: [cloudflareTest(wranglerOptions)],
  test: {
    pool: cloudflarePool(wranglerOptions),
    // Vitest's default is 5s, which is tight for this pool specifically.
    // Every test file boots a Workers runtime and applies the full migration
    // set before its first assertion, and the heavier route tests drive a
    // dozen or more sequential worker.fetch + D1 round trips inside a single
    // `it`. Locally those finish in well under a second; on a loaded CI
    // runner executing the whole suite in parallel they don't reliably, and
    // the first casualty was groups.test.ts's "rejects joining once the group
    // is full" (8 sequential joins, ~550ms locally) blowing past 5s and
    // failing a deploy on main with nothing actually broken.
    //
    // This buys headroom for scheduling variance, not for slow code -- a test
    // that genuinely takes 15s is a real problem and should still fail.
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
