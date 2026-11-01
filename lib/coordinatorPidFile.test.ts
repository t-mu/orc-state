import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCoordinatorPidFile, isOwnCoordinatorLock, releaseCoordinatorPidFile, type CoordinatorPidRecord } from './coordinatorPidFile.ts';
import { readProcessStart } from './processIdentity.ts';

let dir: string;
let pidFile: string;
const self: CoordinatorPidRecord = { pid: process.pid, started_at: '2026-11-01T00:00:00.000Z', process_start: readProcessStart(process.pid) };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-pidfile-'));
  pidFile = join(dir, 'coordinator.pid');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A live process that is not this one, to stand in for another coordinator. */
function startOther(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
}

describe('isOwnCoordinatorLock', () => {
  it('matches the same pid, and the same process start when both record one', () => {
    expect(isOwnCoordinatorLock({ pid: self.pid, process_start: self.process_start }, self)).toBe(true);
    expect(isOwnCoordinatorLock({ pid: self.pid }, self)).toBe(true);
    expect(isOwnCoordinatorLock({ pid: self.pid, process_start: 'proc:0' }, self)).toBe(false);
    expect(isOwnCoordinatorLock({ pid: self.pid + 1, process_start: self.process_start }, self)).toBe(false);
    expect(isOwnCoordinatorLock(null, self)).toBe(false);
  });
});

describe('releaseCoordinatorPidFile', () => {
  it('unlinks a pid file that names this coordinator', () => {
    writeFileSync(pidFile, JSON.stringify(self));
    expect(releaseCoordinatorPidFile(pidFile, self)).toBe('removed');
    expect(existsSync(pidFile)).toBe(false);
  });

  it('keeps a pid file that names another process', () => {
    const foreign = JSON.stringify({ pid: self.pid + 100_000, started_at: 'x', process_start: null });
    writeFileSync(pidFile, foreign);
    expect(releaseCoordinatorPidFile(pidFile, self)).toBe('foreign');
    expect(readFileSync(pidFile, 'utf8')).toBe(foreign);
  });

  it('keeps a pid file with this pid but another process start (a reused PID)', () => {
    writeFileSync(pidFile, JSON.stringify({ ...self, process_start: 'proc:0' }));
    expect(releaseCoordinatorPidFile(pidFile, self)).toBe('foreign');
    expect(existsSync(pidFile)).toBe(true);
  });

  it('keeps an unreadable pid file and reports a missing one', () => {
    writeFileSync(pidFile, 'not json');
    expect(releaseCoordinatorPidFile(pidFile, self)).toBe('foreign');
    expect(existsSync(pidFile)).toBe(true);
    rmSync(pidFile);
    expect(releaseCoordinatorPidFile(pidFile, self)).toBe('missing');
  });
});

describe('ensureCoordinatorPidFile', () => {
  it('re-creates a missing pid file with the original payload', () => {
    expect(ensureCoordinatorPidFile(pidFile, self)).toBe('recreated');
    expect(JSON.parse(readFileSync(pidFile, 'utf8'))).toEqual(self);
    expect(ensureCoordinatorPidFile(pidFile, self)).toBe('present');
  });

  it('leaves a pid file naming another live coordinator alone', async () => {
    const other = startOther();
    try {
      await new Promise((resolve) => other.once('spawn', resolve));
      const foreign = JSON.stringify({ pid: other.pid, started_at: 'x', process_start: readProcessStart(other.pid!) });
      writeFileSync(pidFile, foreign);
      expect(ensureCoordinatorPidFile(pidFile, self)).toBe('foreign_live');
      expect(readFileSync(pidFile, 'utf8')).toBe(foreign);
    } finally {
      other.kill();
    }
  });

  it('leaves a pid file naming a process that is not running alone', () => {
    const stale = JSON.stringify({ pid: self.pid, started_at: 'x', process_start: 'proc:0' });
    writeFileSync(pidFile, stale);
    expect(ensureCoordinatorPidFile(pidFile, self)).toBe('foreign_stale');
    expect(readFileSync(pidFile, 'utf8')).toBe(stale);
  });
});
