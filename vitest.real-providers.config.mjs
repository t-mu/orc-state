import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    // Opt-in suite: only files under e2e-real/
    include: [resolve(import.meta.dirname, 'e2e-real/**/*.test.ts')],
    exclude: ['**/node_modules/**'],
    // Real provider runs must never overlap — serial execution only.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
