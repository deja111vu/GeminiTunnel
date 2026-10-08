import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    // Modules like logger/flow load Config at import time. Tests that
    // transitively pull them in need a valid env to construct. Production
    // secrets stay in .env / orchestrator secrets; these are non-secret
    // placeholders for the test runtime only.
    env: {
      ADMIN_TOKEN: '0000000000000000000000000000000000000000000000000000000000000000',
      ACCOUNTS_ENCRYPTION_KEY:
        '1111111111111111111111111111111111111111111111111111111111111111',
      GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret',
    },
  },
});
