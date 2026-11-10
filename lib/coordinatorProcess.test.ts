import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: spawnMock }));

const findLiveCoordinatorMock = vi.hoisted(() => vi.fn());
vi.mock('./coordinatorLiveness.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./coordinatorLiveness.ts')>();
  return { ...actual, findLiveCoordinator: vi.fn((stateDir: string) => findLiveCoordinatorMock(stateDir) ?? actual.findLiveCoordinator(stateDir)) };
});
const isZombieMock = vi.hoisted(() => vi.fn());
vi.mock('./processIdentity.ts', async (importOriginal) => ({ ...await importOriginal<typeof import('./processIdentity.ts')>(), isZombie: isZombieMock }));

const { restartCoordinator, spawnCoordinator, stopCoordinator } = await import('./coordinatorProcess.ts');

let stateDir: string | null = null;
afterEach(() => {
  spawnMock.mockReset();
  findLiveCoordinatorMock.mockReset();
  isZombieMock.mockReset();
  vi.restoreAllMocks();
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

describe('stopCoordinator', () => {
  const PID = 424242;

  function liveCoordinatorAt(pid: number): void {
    stateDir = createTempStateDir('orc-coordinator-process-');
    writeFileSync(join(stateDir, 'coordinator.pid'), JSON.stringify({ pid, started_at: '2026-11-10T00:00:00.000Z' }));
    findLiveCoordinatorMock.mockReturnValue({ pid, source: 'pid_file' });
  }

  it('treats a zombie coordinator as stopped without signalling or waiting, and removes its pid file', async () => {
    liveCoordinatorAt(PID);
    isZombieMock.mockReturnValue(true);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const started = Date.now();
    expect(await stopCoordinator(stateDir!, PID)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(kill).not.toHaveBeenCalledWith(PID, 'SIGTERM');
    expect(existsSync(join(stateDir!, 'coordinator.pid'))).toBe(false);
  });

  it('treats a coordinator that becomes a zombie after SIGTERM as stopped', async () => {
    liveCoordinatorAt(PID);
    let terminated = false;
    isZombieMock.mockImplementation(() => terminated);
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') terminated = true;
      return true;
    });
    const started = Date.now();
    expect(await stopCoordinator(stateDir!, PID)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(existsSync(join(stateDir!, 'coordinator.pid'))).toBe(false);
  });

  it('still gives up on a live coordinator that ignores SIGTERM', async () => {
    liveCoordinatorAt(PID);
    isZombieMock.mockReturnValue(false);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await stopCoordinator(stateDir!, PID)).toBe(false);
    expect(kill).toHaveBeenCalledWith(PID, 'SIGTERM');
    expect(existsSync(join(stateDir!, 'coordinator.pid'))).toBe(true);
  });
});
