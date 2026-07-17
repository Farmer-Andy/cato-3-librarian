import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // Fake values for tests only — real secrets are set via `wrangler secret put`.
        bindings: {
          OPENROUTER_API_KEY: 'test-not-a-real-key',
          TELEGRAM_BOT_TOKEN: 'test-not-a-real-token',
          ADMIN_TELEGRAM_ID: '12345678',
          ADMIN_TOKEN: 'test-admin-token',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.spec.ts'],
  },
});
