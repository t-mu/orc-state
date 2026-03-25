import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('paths', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('./repoRoot.ts');
  });

  it('defaults STATE_DIR to the canonical repo root instead of the ambient cwd', async () => {
    vi.doMock('./repoRoot.ts', () => ({
      resolveRepoRoot: vi.fn().mockReturnValue('/tmp/repo-root'),
    }));

    const { STATE_DIR, EVENTS_FILE, ORCHESTRATOR_CONFIG_FILE, RUN_WORKTREES_FILE } = await import('./paths.ts');
    expect(STATE_DIR).toBe('/tmp/repo-root/.orc-state');
    expect(EVENTS_FILE).toBe('/tmp/repo-root/.orc-state/events.db');
    expect(ORCHESTRATOR_CONFIG_FILE).toBe('/tmp/repo-root/orchestrator.config.json');
    expect(RUN_WORKTREES_FILE).toBe('/tmp/repo-root/.orc-state/run-worktrees.json');
  });

  it('still honors ORCH_STATE_DIR overrides explicitly', async () => {
    vi.stubEnv('ORCH_STATE_DIR', '/tmp/override-state');
    const { STATE_DIR } = await import('./paths.ts');
    expect(STATE_DIR).toBe('/tmp/override-state');
  });
});
