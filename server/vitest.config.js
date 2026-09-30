import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.js'],
    // API test files share one database, so run files one at a time.
    fileParallelism: false,
  },
});
