import { defineConfig } from 'vitest/config';
import { stripInheritedOrcEnv, TEST_DATA_HOME } from './vitest.orcEnv.mjs';
import { resolve } from 'node:path';

stripInheritedOrcEnv();

export default defineConfig({
  test: {
    environment: 'node',
    // Tests get a private TMUX_TMPDIR so they never leak sockets into /tmp/tmux-<uid>.
    globalSetup: [resolve(import.meta.dirname, 'vitest.tmuxTmpdir.mjs')],
    // The e2e-real harness gives each test its own temp ORC_DATA_HOME; the test
    // process itself must not resolve the developer's real registry.
    env: { ORC_DATA_HOME: TEST_DATA_HOME },
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
