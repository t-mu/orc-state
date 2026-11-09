import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: spawnMock }));

const { restartCoordinator, spawnCoordinator } = await import('./coordinatorProcess.ts');

let stateDir: string | null = null;
afterEach(() => {
  spawnMock.mockReset();
  if (stateDir) cleanupTempStateDir(stateDir);
  stateDir = null;
});

describe('spawnCoordinator', () => {
  it('starts a detached, unref\'d coordinator without the spawning session\'s secrets', async () => {
    stateDir = createTempStateDir('orc-coordinator-process-');
    const unref = vi.fn();
    spawnMock.mockReturnValue({ unref });
    vi.stubEnv('ORC_MASTER_SECRET', 'master-secret');
    vi.stubEnv('ORC_SESSION_SECRET', 'session-secret');
    try {
      expect(await spawnCoordinator(stateDir, 'p1')).toBeNull(); // the mock never comes up
    } finally {
      vi.unstubAllEnvs();
    }
    const [, , options] = spawnMock.mock.calls[0] as [string, string[], { detached: boolean; stdio: string; env: NodeJS.ProcessEnv }];
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(unref).toHaveBeenCalled();
    expect(options.env).toMatchObject({ ORC_PROJECT_ID: 'p1', ORC_STATE_DIR: stateDir });
    expect(options.env.ORC_MASTER_SECRET).toBeUndefined();
    expect(options.env.ORC_SESSION_SECRET).toBeUndefined();
  });
});

describe('restartCoordinator', () => {
  it('with none running starts one and reports a coordinator that never comes up as unavailable', async () => {
    stateDir = createTempStateDir('orc-coordinator-process-');
    spawnMock.mockReturnValue({ unref: vi.fn() });
    await expect(restartCoordinator(stateDir, 'p1')).rejects.toMatchObject({ code: 'unavailable' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
