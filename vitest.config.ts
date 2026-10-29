import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000, // password hashing is slow on purpose; the 5 s default is too short
    hookTimeout: 30_000,
    fileParallelism: false, // tests share one database
    setupFiles: ['dotenv/config'], // load .env (SEED_ADMIN_EMAIL etc.) into the test process
  },
});
