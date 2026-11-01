import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CONTROL_ENDPOINT_FILE } from './controlProtocol.ts';
import { isPidAlive, isSameProcess } from './processIdentity.ts';

/** The coordinator pid lock's contents; `process_start` is absent in locks written before it was recorded. */
export interface CoordinatorLock { pid?: unknown; started_at?: unknown; process_start?: unknown }

/** Where a live coordinator was found: its pid lock, or (when the lock is missing or stale) its control endpoint. */
export type CoordinatorSource = 'pid_file' | 'control_json';

export interface LiveCoordinator { pid: number; source: CoordinatorSource }

const COORDINATOR_SCRIPT = /^coordinator\.(js|ts)$/;
const COORDINATOR_COMMAND = /(^|[/\s])coordinator\.(js|ts)(\s|$)/;

/**
 * True when this lock names a live process. A recorded start fingerprint
 * tells a reused PID (common in containers) from the recorder; a record
 * without one falls back to the bare PID.
 */
export function isCoordinatorLockHeld(lock: CoordinatorLock | null | undefined): boolean {
  const pid = lock?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  return typeof lock?.process_start === 'string' ? isSameProcess({ pid, start: lock.process_start }) : isPidAlive(pid);
}

/** True when the process runs an orc coordinator script (`coordinator.js` or `coordinator.ts`). */
export function isCoordinatorProcess(pid: number): boolean {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    return argv.some((arg) => COORDINATOR_SCRIPT.test(basename(arg)));
  } catch { /* no procfs (macOS) */ }
  // ps joins argv with spaces, so match the script name in the whole line: its path may contain spaces.
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return ps.status === 0 && COORDINATOR_COMMAND.test(String(ps.stdout ?? '').trim());
}

function readJson(path: string): CoordinatorLock | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CoordinatorLock;
  } catch {
    return null;
  }
}

/**
 * The pid a coordinator record names when it is a live coordinator: alive,
 * matching the recorded start fingerprint (when one was recorded) and running
 * a coordinator script. A dead or reused PID is never returned.
 */
function verifiedCoordinatorPid(record: CoordinatorLock | null): number | null {
  if (!isCoordinatorLockHeld(record)) return null;
  const pid = record!.pid as number;
  return isCoordinatorProcess(pid) ? pid : null;
}

/** The pid of the live coordinator holding this state directory's pid lock, or null. */
function pidFileCoordinatorPid(stateDir: string): number | null {
  return verifiedCoordinatorPid(readJson(join(stateDir, 'coordinator.pid')));
}

/**
 * The pid of a live coordinator recorded in this state directory's control
 * endpoint (`control.json`), or null. The endpoint outlives a deleted pid lock.
 */
export function controlEndpointCoordinatorPid(stateDir: string): number | null {
  return verifiedCoordinatorPid(readJson(join(stateDir, CONTROL_ENDPOINT_FILE)));
}

/**
 * The live coordinator for this state directory: the pid lock first, then the
 * control endpoint, so a coordinator whose `coordinator.pid` went missing is
 * still found (and stopped, and not started twice).
 */
export function findLiveCoordinator(stateDir: string): LiveCoordinator | null {
  const fromPidFile = pidFileCoordinatorPid(stateDir);
  if (fromPidFile !== null) return { pid: fromPidFile, source: 'pid_file' };
  const fromEndpoint = controlEndpointCoordinatorPid(stateDir);
  return fromEndpoint !== null ? { pid: fromEndpoint, source: 'control_json' } : null;
}

/** The pid of the live coordinator for this state directory, or null. */
export function runningCoordinatorPid(stateDir: string): number | null {
  return findLiveCoordinator(stateDir)?.pid ?? null;
}

/**
 * A doctor problem when a live coordinator, found through its control
 * endpoint, has no `coordinator.pid` or one naming a different pid: without
 * the lock another coordinator could start against the same state.
 */
export function coordinatorPidFileProblem(stateDir: string): string | null {
  const pid = controlEndpointCoordinatorPid(stateDir);
  if (pid === null) return null;
  const lock = readJson(join(stateDir, 'coordinator.pid'));
  if (lock === null) return `coordinator PID ${pid} is running but ${join(stateDir, 'coordinator.pid')} is missing; stop it with orc kill-all and restart`;
  if (lock.pid !== pid) return `coordinator PID ${pid} is running but coordinator.pid names PID ${String(lock.pid)}; stop it with orc kill-all and restart`;
  return null;
}
