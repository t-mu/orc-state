import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { stripInheritedOrcEnv, TEST_DATA_HOME } from './vitest.orcEnv.mjs';

stripInheritedOrcEnv();

export default defineConfig({
  test: {
    environment: 'node',
    // Tests get a private TMUX_TMPDIR so they never leak sockets into /tmp/tmux-<uid>.
    globalSetup: [resolve(import.meta.dirname, 'vitest.tmuxTmpdir.mjs')],
    env: { ORC_DATA_HOME: TEST_DATA_HOME },
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/e2e/**', '**/e2e-real/**', '.worktrees/**', '**/.worktrees/**', '.orc-state/**', '**/.orc-state/**'],
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
  },
});
