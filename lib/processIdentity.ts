import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * A PID alone cannot identify a process across restarts: the kernel reuses
 * PIDs. Pair it with the process start time so a reused PID is detected.
 */
export interface ProcessIdentity {
  pid: number;
  start: string;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function psStart(pid: number, env: NodeJS.ProcessEnv): string {
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env });
  return ps.status === 0 ? ps.stdout.trim() : '';
}

/**
 * Start-time fingerprint, or null when the process does not exist. Without
 * procfs (macOS) it is `ps`'s start time, read in UTC and the C locale so
 * every reader agrees whatever its own TZ or locale (`psutc:`).
 */
export function readProcessStart(pid: number): string | null {
  if (!isPidAlive(pid)) return null;
  try {
    // Field 22 of /proc/<pid>/stat; the command name (field 2) may contain spaces.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[19]) return `proc:${fields[19]}`;
  } catch { /* no procfs (macOS) */ }
  const start = psStart(pid, { ...process.env, TZ: 'UTC', LC_ALL: 'C' });
  return start ? `psutc:${start}` : null;
}

export function processIdentity(pid: number): ProcessIdentity | null {
  const start = readProcessStart(pid);
  return start ? { pid, start } : null;
}

/**
 * True only when the PID is alive and still belongs to the recorded process.
 * A `ps:` fingerprint recorded before readings were normalised was taken in
 * the recorder's own TZ and locale, so it is compared the same way.
 */
export function isSameProcess(identity: ProcessIdentity): boolean {
  if (identity.start.startsWith('ps:')) {
    if (!isPidAlive(identity.pid)) return false;
    const start = psStart(identity.pid, process.env);
    return start !== '' && `ps:${start}` === identity.start;
  }
  return readProcessStart(identity.pid) === identity.start;
}

/** The state letter of a `/proc/<pid>/stat` line, or null; the command name (field 2) may contain spaces and parentheses. */
export function parseProcStatState(stat: string): string | null {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const state = stat.slice(end + 2).split(' ')[0];
  return state ? state : null;
}

/** True when `ps -o stat=` output names a zombie (`Z`, `Zs`, ...). */
export function isZombiePsStat(stat: string): boolean {
  return stat.trim().startsWith('Z');
}

/** True when the PID is a zombie: exited, not yet reaped, yet still answering `kill(pid, 0)`. A missing or unreadable entry is not a zombie. */
export function isZombie(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    return parseProcStatState(readFileSync(`/proc/${pid}/stat`, 'utf8')) === 'Z';
  } catch { /* no procfs (macOS), or the PID is gone */ }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return ps.status === 0 && isZombiePsStat(String(ps.stdout ?? ''));
}
