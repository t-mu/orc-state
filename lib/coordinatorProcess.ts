import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLiveCoordinator } from './coordinatorLiveness.ts';
import { ControlClient, controlSocketFromEnv } from './controlClient.ts';
import { ControlError, defaultSocketPath } from './controlProtocol.ts';
import { staleCodeWarning } from './codeIdentity.ts';
import { stripNestedProviderEnv } from './providerChildEnv.ts';
import { isZombie } from './processIdentity.ts';
import { ensureStateInitialized } from './stateInit.ts';

/** The coordinator entry point beside this build: `coordinator.ts` from a checkout, `coordinator.js` from `dist/`. */
export function coordinatorScriptPath(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../coordinator.ts' : '../coordinator.js', import.meta.url));
}

export function isValidPid(pid: unknown): pid is number {
  return Number.isInteger(pid) && (pid as number) > 0;
}

/** The pid lock's pid and start time; null when the file is missing or unreadable. */
export function readCoordinatorPidRecord(stateDir: string): { pid: number; started_at: string | null } | null {
  const file = join(stateDir, 'coordinator.pid');
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!isValidPid(data?.pid)) return null;
    return { pid: Number(data.pid), started_at: typeof data.started_at === 'string' ? data.started_at : null };
  } catch {
    return null;
  }
}

function removeCoordinatorPidFileIfMatches(stateDir: string, pid: number): void {
  if (readCoordinatorPidRecord(stateDir)?.pid !== pid) return;
  try {
    unlinkSync(join(stateDir, 'coordinator.pid'));
  } catch {
    // already gone
  }
}

/** The live coordinator, found through coordinator.pid or, with that file missing or stale, control.json. */
export function coordinatorStatus(stateDir: string): { running: boolean; pid: number | null } {
  const live = findLiveCoordinator(stateDir);
  return live ? { running: true, pid: live.pid } : { running: false, pid: readCoordinatorPidRecord(stateDir)?.pid ?? null };
}

/** Start a detached coordinator for the project and wait up to 2 s for it to be live (a stale pid lock does not count); null when it did not appear. */
export async function spawnCoordinator(stateDir: string, projectId: string): Promise<number | null> {
  const child = spawn(process.execPath, [coordinatorScriptPath()], {
    // A coordinator spawned from a session (the master's MCP server) must not inherit that session's secret.
    env: { ...stripNestedProviderEnv(process.env), ORC_PROJECT_ID: projectId, ORC_STATE_DIR: stateDir },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const pid = findLiveCoordinator(stateDir)?.pid ?? null;
    if (pid) return pid;
  }
  return null;
}

/** SIGTERM the verified coordinator `pid` and wait up to 2 s for it to exit; false when it is not (or does not stop as) this state's coordinator. */
export async function stopCoordinator(stateDir: string, pid: number): Promise<boolean> {
  if (!isValidPid(pid)) return false;
  // Only a PID verified as this state's live coordinator is ever signalled,
  // and a pid lock without started_at is not trusted for a terminate.
  const live = findLiveCoordinator(stateDir);
  if (live?.pid !== pid) return false;
  if (live.source === 'pid_file' && !readCoordinatorPidRecord(stateDir)?.started_at) return false;

  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ESRCH') {
      removeCoordinatorPidFileIfMatches(stateDir, pid);
      return true;
    }
    return false;
  }
  // A zombie (exited, not yet reaped) still answers kill(pid, 0) but has already stopped.
  if (isZombie(pid)) {
    removeCoordinatorPidFileIfMatches(stateDir, pid);
    return true;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    let gone = false;
    try {
      process.kill(pid, 0);
      gone = isZombie(pid);
    } catch (e) {
      gone = (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
    if (gone) {
      removeCoordinatorPidFileIfMatches(stateDir, pid);
      return true;
    }
  }
  return false;
}

/** What `orc coordinator` and `restart_coordinator` report. `version`, `started_at` and `stale` come from the running coordinator's control API, when it answers. */
export interface CoordinatorDescription {
  running: boolean;
  pid: number | null;
  version: string | null;
  socket: string | null;
  started_at: string | null;
  stale: string | null;
}

export async function describeCoordinator(stateDir: string, socketPath: string | null = controlSocketFromEnv()): Promise<CoordinatorDescription> {
  const { running, pid } = coordinatorStatus(stateDir);
  if (!running) return { running, pid: null, version: null, socket: null, started_at: null, stale: null };
  const socket = socketPath ?? defaultSocketPath(stateDir);
  try {
    const health = await new ControlClient(stateDir, { timeoutMs: 3_000, socketPath }).health();
    return { running, pid, version: health.version, socket, started_at: health.started_at, stale: staleCodeWarning(health) };
  } catch {
    // Starting up, or a coordinator that predates /v1/health: the pid is still true.
    return { running, pid, version: null, socket, started_at: null, stale: null };
  }
}

/** The coordinator fields of `get_status` and `orc status --json`: `orc coordinator status` without the socket. */
export async function coordinatorSummary(stateDir: string): Promise<Pick<CoordinatorDescription, 'running' | 'pid' | 'version' | 'started_at' | 'stale'>> {
  const { running, pid, version, started_at, stale } = await describeCoordinator(stateDir);
  return { running, pid, version, started_at, stale };
}

/**
 * Stop the running coordinator, if any; the pid it stopped, or null when none ran.
 * Throws `conflict` for a pid lock without started_at (never signalled: a permanent refusal) and `unavailable` when it does not stop.
 */
export async function stopRunningCoordinator(stateDir: string): Promise<number | null> {
  const { running, pid } = coordinatorStatus(stateDir);
  if (!running || pid === null) return null;
  if (findLiveCoordinator(stateDir)?.source === 'pid_file' && !readCoordinatorPidRecord(stateDir)?.started_at) {
    throw new ControlError('conflict', `coordinator.pid names PID ${pid} but records no started_at, so orc will not signal it; stop that process by hand`, 409);
  }
  if (!await stopCoordinator(stateDir, pid)) {
    throw new ControlError('unavailable', `coordinator PID ${pid} is still running; retry, or use orc kill-all`, 503);
  }
  return pid;
}

/** Start a coordinator unless one runs; its pid and whether this call started it. Throws `unavailable` when it does not come up. */
export async function startCoordinatorIfStopped(stateDir: string, projectId: string): Promise<{ pid: number; started: boolean }> {
  const { running, pid } = coordinatorStatus(stateDir);
  if (running && pid !== null) return { pid, started: false };
  ensureStateInitialized(stateDir);
  const spawned = await spawnCoordinator(stateDir, projectId);
  if (spawned === null) throw new ControlError('unavailable', 'coordinator did not come up within 2 s; check orc status, then retry', 503);
  return { pid: spawned, started: true };
}

/**
 * Stop the running coordinator (as stopRunningCoordinator) and start a new, detached one; with none running, just start one.
 * Tasks, claims, agents, worktrees and worker sessions are left alone: the new coordinator adopts live sessions on start.
 */
export async function restartCoordinator(stateDir: string, projectId: string): Promise<{ previous_pid: number | null; pid: number }> {
  const previous_pid = await stopRunningCoordinator(stateDir);
  const { pid } = await startCoordinatorIfStopped(stateDir, projectId);
  return { previous_pid, pid };
}
