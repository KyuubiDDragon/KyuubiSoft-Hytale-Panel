import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks', // better-sqlite3 + globals isolation
    testTimeout: 10_000,
    // Data and server folders a test does not set itself point into a temp folder.
    setupFiles: ['src/test/isolatePaths.ts'],
  },
});
