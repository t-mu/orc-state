import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: [resolve(import.meta.dirname, '**/*.integration.test.mjs')],
    exclude: ['**/node_modules/**', resolve(import.meta.dirname, 'e2e/**')],
  },
});
