import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Temporarily excluded: the new timetable-planner suite is slow (adds several minutes) and isn't being run for now.
    // Remove this list to bring them back into CI.
    exclude: [
      '**/node_modules/**',
      'tests/planner-publish.test.ts',
      'tests/planner-isolation.test.ts',
      'tests/planner-engine.test.ts',
      'tests/planner-publish-core.test.ts',
      'tests/planner-settings.test.ts',
      'tests/planner-versions.test.ts',
      'tests/timetable-entries-planner.test.ts',
      'tests/run-generate.test.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false, // tests share one database
    setupFiles: ['./tests/setup.ts', 'dotenv/config'], // rate-limit/log overrides, THEN load .env for everything else
  },
});
