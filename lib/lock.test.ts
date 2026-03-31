import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, releaseLock, withLock, withLockAsync } from './lock.ts';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = createTempStateDir('orch-lock-test-');
  lockPath = join(dir, '.lock');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('acquireLock / releaseLock', () => {
  it('creates the lock file on acquire', () => {
    acquireLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(lockPath);
  });

  it('removes the lock file on release', () => {
    acquireLock(lockPath);
    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('throws when lock is already held', () => {
    acquireLock(lockPath);
    expect(() => acquireLock(lockPath)).toThrow('Lock already held');
    releaseLock(lockPath);
  });

  it('releaseLock is a no-op when lock file is already gone', () => {
    expect(() => releaseLock(lockPath)).not.toThrow();
  });

  it('releaseLock throws if lock is owned by another process', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 9999999 }));
    expect(() => releaseLock(lockPath)).toThrow('Cannot release lock owned by process');
    expect(existsSync(lockPath)).toBe(true);
  });

  it('releaseLock throws for unreadable metadata', () => {
    writeFileSync(lockPath, '');
    expect(() => releaseLock(lockPath)).toThrow('Cannot release lock with unreadable metadata');
  });

  it('releaseLock throws for invalid pid metadata', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 0 }));
    expect(() => releaseLock(lockPath)).toThrow('Cannot release lock with invalid pid metadata');
  });

  it('releaseLock throws when token does not match held lock token', () => {
    acquireLock(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'tampered' }));
    expect(() => releaseLock(lockPath)).toThrow('Cannot release lock with mismatched token');
  });

  it('breaks a stale lock and acquires successfully', () => {
    // Use an impossible PID so liveness check proves owner is dead.
    writeFileSync(lockPath, JSON.stringify({ pid: 9999999 }));
    const pastDate = new Date(Date.now() - 60_000);
    utimesSync(lockPath, pastDate, pastDate);

    expect(() => acquireLock(lockPath)).not.toThrow();
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(lockPath);
  });

  it('fails closed for stale lock with malformed metadata', () => {
    writeFileSync(lockPath, '');
    const pastDate = new Date(Date.now() - 60_000);
    utimesSync(lockPath, pastDate, pastDate);

    expect(() => acquireLock(lockPath)).toThrow('Stale lock has unreadable metadata');
  });

  it('fails closed for stale lock with invalid pid metadata', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 'x' }));
    const pastDate = new Date(Date.now() - 60_000);
    utimesSync(lockPath, pastDate, pastDate);
    expect(() => acquireLock(lockPath)).toThrow('Stale lock is missing valid pid metadata');

    writeFileSync(lockPath, JSON.stringify({ pid: 0 }));
    utimesSync(lockPath, pastDate, pastDate);
    expect(() => acquireLock(lockPath)).toThrow('Stale lock is missing valid pid metadata');
  });

  it('does not break stale lock when owner pid is still alive', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
    const pastDate = new Date(Date.now() - 60_000);
    utimesSync(lockPath, pastDate, pastDate);

    expect(() => acquireLock(lockPath)).toThrow(`Lock held by live process ${process.pid}`);
  });

  it('breaks extremely stale malformed lock to avoid permanent deadlock', () => {
    writeFileSync(lockPath, '');
    const veryPastDate = new Date(Date.now() - 700_000);
    utimesSync(lockPath, veryPastDate, veryPastDate);

    expect(() => acquireLock(lockPath)).not.toThrow();
    releaseLock(lockPath);
  });
});

describe('withLock', () => {
  it('executes fn and returns its value', () => {
    const result = withLock(lockPath, () => 42);
    expect(result).toBe(42);
  });

  it('releases the lock even when fn throws', () => {
    expect(() =>
      withLock(lockPath, () => { throw new Error('boom'); })
    ).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not allow re-entrant locking (lock is held during fn)', () => {
    expect(() =>
      withLock(lockPath, () => {
        acquireLock(lockPath); // should throw — lock is still held
      })
    ).toThrow('Lock already held');
  });

  it('preserves callback error as cause if release also fails', () => {
    expect(() =>
      withLock(lockPath, () => {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'tampered' }));
        throw new Error('boom');
      })
    ).toThrow('Lock release failed after callback error');
  });
});

describe('withLockAsync', () => {
  it('executes async fn and returns resolved value', async () => {
    const result = await withLockAsync(lockPath, () => Promise.resolve('hello'));
    expect(result).toBe('hello');
  });

  it('releases the lock even when async fn rejects', async () => {
    await expect(
      withLockAsync(lockPath, () => Promise.reject(new Error('async boom')))
    ).rejects.toThrow('async boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('preserves async callback error as cause if release also fails', async () => {
    await expect(
      withLockAsync(lockPath, () => {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'tampered' }));
        return Promise.reject(new Error('async boom'));
      })
    ).rejects.toThrow('Lock release failed after callback error');
  });
});

describe('acquireLock retry exhaustion', () => {
  it('throws retry exhaustion error when lock remains concurrently unavailable', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      const eexist = new Error('exists');
      (eexist as NodeJS.ErrnoException).code = 'EEXIST';
      return {
        ...actual,
        openSync: vi.fn(() => { throw eexist; }),
        existsSync: vi.fn(() => false),
      };
    });

    const mod = await import('./lock.ts');
    expect(() => mod.acquireLock('/tmp/never-created.lock')).toThrow('Failed to acquire lock due to concurrent updates');
    vi.doUnmock('node:fs');
  });

  it('succeeds on third attempt after two stale-lock breaks in a tight race', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      const eexist = new Error('exists');
      (eexist as NodeJS.ErrnoException).code = 'EEXIST';

      const openSync = vi.fn()
        .mockImplementationOnce(() => { throw eexist; })
        .mockImplementationOnce(() => { throw eexist; })
        .mockImplementation(() => 42);

      const closeSync = vi.fn();
      const writeSync = vi.fn();
      const existsSync = vi.fn(() => true);
      const statSync = vi.fn(() => ({ mtimeMs: Date.now() - 60_000 }));
      const readFileSync = vi.fn(() => JSON.stringify({ pid: 9999999 }));
      const unlinkSync = vi.fn();

      return {
        ...actual,
        openSync,
        closeSync,
        writeSync,
        existsSync,
        statSync,
        readFileSync,
        unlinkSync,
      };
    });

    const mod = await import('./lock.ts');
    expect(() => mod.acquireLock('/tmp/racy-stale.lock')).not.toThrow();
    vi.doUnmock('node:fs');
  });
});
