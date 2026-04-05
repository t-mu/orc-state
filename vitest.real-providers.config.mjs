import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    // Run real-provider tests serially — provider PTYs and auth state must not
    // be exercised concurrently.
    fileParallelism: false,
    singleThread: true,
    include: [resolve(import.meta.dirname, 'e2e-real/**/*.test.ts')],
    exclude: ['**/node_modules/**'],
    testTimeout: 300_000, // 5 min per test — real provider startup can be slow
  },
});
