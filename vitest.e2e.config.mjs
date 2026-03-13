import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    // Absolute path so this config works whether vitest is run from the repo root.
    include: [resolve(import.meta.dirname, 'e2e/**/*.test.ts')],
    exclude: ['**/node_modules/**'],
  },
});
