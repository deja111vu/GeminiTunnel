import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
  },
});
