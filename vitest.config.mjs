import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit tests drive the node-pty path; tmux tests opt in explicitly.
    // A developer's real project registry must never select a project for tests.
    env: { ORC_SESSION_TRANSPORT: 'pty', ORC_DATA_HOME: '/nonexistent/orc-test-data-home', ORC_PROJECT_ID: '' },
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/e2e/**', '**/e2e-real/**', '.worktrees/**', '**/.worktrees/**', '.orc-state/**', '**/.orc-state/**'],
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
  },
});
