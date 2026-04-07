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
    testTimeout: 1_800_000, // 30 min per test — full phased workflow with real providers
    hookTimeout: 120_000,  // 2 min for beforeAll/afterAll (coordinator startup/teardown)
  },
});
