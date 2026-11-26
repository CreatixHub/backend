import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false, // tests share one database
    setupFiles: ['./tests/setup.ts', 'dotenv/config'], // rate-limit/log overrides, THEN load .env for everything else
  },
});
