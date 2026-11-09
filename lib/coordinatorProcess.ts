import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLiveCoordinator } from './coordinatorLiveness.ts';

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

/** Start a detached coordinator for the project and wait up to 2 s for its pid lock; null when none appeared. */
export async function spawnCoordinator(stateDir: string, projectId: string): Promise<number | null> {
  const child = spawn(process.execPath, [coordinatorScriptPath()], {
    env: { ...process.env, ORC_PROJECT_ID: projectId, ORC_STATE_DIR: stateDir },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const pid = readCoordinatorPidRecord(stateDir)?.pid ?? null;
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
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
        removeCoordinatorPidFileIfMatches(stateDir, pid);
        return true;
      }
    }
  }
  return false;
}
