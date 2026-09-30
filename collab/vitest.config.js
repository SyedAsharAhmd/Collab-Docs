import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.js'],
    // Test files share one database, so run them one at a time.
    fileParallelism: false,
  },
});
