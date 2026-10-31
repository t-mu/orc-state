import { defineConfig } from 'vitest/config';
import { stripInheritedOrcEnv, TEST_DATA_HOME } from './vitest.orcEnv.mjs';
import { resolve } from 'node:path';

stripInheritedOrcEnv();

export default defineConfig({
  test: {
    environment: 'node',
    // Tests get a private TMUX_TMPDIR so they never leak sockets into /tmp/tmux-<uid>.
    globalSetup: [resolve(import.meta.dirname, 'vitest.tmuxTmpdir.mjs')],
    env: { ORC_SESSION_TRANSPORT: 'pty', ORC_DATA_HOME: TEST_DATA_HOME },
    include: [resolve(import.meta.dirname, '**/*.integration.test.ts')],
    exclude: ['**/node_modules/**', resolve(import.meta.dirname, 'e2e/**')],
  },
});
