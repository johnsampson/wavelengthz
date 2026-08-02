import { defineConfig } from 'vitest/config';
import { cloudflareTest, cloudflarePool } from '@cloudflare/vitest-pool-workers';

const wranglerOptions = { wrangler: { configPath: './wrangler.toml', environment: 'test' } };

export default defineConfig({
  plugins: [cloudflareTest(wranglerOptions)],
  test: {
    pool: cloudflarePool(wranglerOptions),
  },
});
