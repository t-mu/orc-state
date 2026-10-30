import { defineConfig } from 'vitest/config';
import { stripInheritedOrcEnv, TEST_DATA_HOME } from './vitest.orcEnv.mjs';

stripInheritedOrcEnv();

export default defineConfig({
  test: {
    environment: 'node',
    // Unit tests drive the node-pty path; tmux tests opt in explicitly.
    env: { ORC_SESSION_TRANSPORT: 'pty', ORC_DATA_HOME: TEST_DATA_HOME },
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/e2e/**', '**/e2e-real/**', '.worktrees/**', '**/.worktrees/**', '.orc-state/**', '**/.orc-state/**'],
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
  },
});
