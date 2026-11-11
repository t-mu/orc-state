import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimInstance, exitRequestPath, exitRequested, liveInstance, parseHolder, type InstanceHolder } from './instance.ts';
import { readLockFile } from './lockFile.ts';

let dir: string;
let lockPath: string;
/** The processes that run, by `pid start`: what `isRunning` sees. */
let running: Set<string>;
const key = (holder: InstanceHolder) => `${holder.pid} ${holder.start}`;
const isRunning = (holder: InstanceHolder) => running.has(key(holder));
const A: InstanceHolder = { pid: 1001, start: 'proc:111' };
const B: InstanceHolder = { pid: 1002, start: 'proc:222' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-cockpit-instance-'));
  lockPath = join(dir, 'cockpit.lock');
  running = new Set([key(A), key(B)]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const claim = (self: InstanceHolder, wake: (holder: InstanceHolder) => void = () => {}, timeoutMs = 2_000) =>
  claimInstance({ lockPath, self, isRunning, wake, timeoutMs, pollMs: 5 });

describe('claimInstance', () => {
  it('takes a free lock, naming this process with its start time; release frees it', async () => {
    const claimed = await claim(A);
    expect(claimed.replaced).toBeNull();
    expect(parseHolder(readLockFile(lockPath))).toEqual(A);
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(liveInstance(lockPath, isRunning)).toEqual(A);
    claimed.release();
    claimed.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('creates the lock\'s directory on a fresh data home', async () => {
    lockPath = join(dir, 'cockpit', 'cockpit.lock');
    const claimed = await claim(A);
    expect(parseHolder(readLockFile(lockPath))).toEqual(A);
    expect(statSync(join(dir, 'cockpit')).mode & 0o777).toBe(0o700);
    claimed.release();
  });

  it('takes over a stale lock silently: its pid is dead', async () => {
    await claim(A);
    running.delete(key(A)); // A was killed without releasing
    const woken: InstanceHolder[] = [];
    const claimed = await claim(B, (holder) => woken.push(holder));
    expect(claimed.replaced).toBeNull();
    expect(woken).toEqual([]);
    expect(parseHolder(readLockFile(lockPath))).toEqual(B);
    expect(liveInstance(lockPath, isRunning)).toEqual(B);
  });

  it('takes over silently when the pid was reused by another process (the start time differs)', async () => {
    await claim(A);
    running = new Set([key({ pid: A.pid, start: 'proc:999' }), key(B)]); // pid 1001 now runs something else
    const woken: InstanceHolder[] = [];
    const claimed = await claim(B, (holder) => woken.push(holder));
    expect(claimed.replaced).toBeNull();
    expect(woken).toEqual([]);
    expect(parseHolder(readLockFile(lockPath))).toEqual(B);
  });

  it('asks a running cockpit to exit once and takes the lock when it lets go', async () => {
    const first = await claim(A);
    const woken: InstanceHolder[] = [];
    const second = claim(B, (holder) => {
      woken.push(holder);
      // The running cockpit's wake-up: it sees the request (naming B) and quits, releasing the lock a little later.
      expect(exitRequested(lockPath, A, isRunning)).toBe(true);
      setTimeout(() => first.release(), 30);
    });
    const claimed = await second;
    expect(claimed.replaced).toEqual(A);
    expect(woken).toEqual([A]);
    expect(parseHolder(readLockFile(lockPath))).toEqual(B);
    // The request was answered: a later wake-up of B is a reload.
    expect(existsSync(exitRequestPath(lockPath))).toBe(false);
    expect(exitRequested(lockPath, B, isRunning)).toBe(false);
    // A, already gone, cannot release B's lock.
    first.release();
    expect(parseHolder(readLockFile(lockPath))).toEqual(B);
  });

  it('keeps an exit request another launch wrote while this one took the lock over', async () => {
    const C: InstanceHolder = { pid: 1003, start: 'proc:333' };
    running.add(key(C));
    const heldByC = await claim(C);
    // C exits and A wins; B, seeing A as the holder, writes its request before A's claim settles.
    const claimed = await claim(A, () => {
      heldByC.release();
      writeFileSync(exitRequestPath(lockPath), `${JSON.stringify(B)}\n`);
    });
    expect(claimed.replaced).toEqual(C);
    expect(parseHolder(readLockFile(lockPath))).toEqual(A);
    // B's wake-up of A is an exit request, not a reload.
    expect(exitRequested(lockPath, A, isRunning)).toBe(true);
    // A request naming a launch that is gone is dropped.
    claimed.release();
    running.delete(key(B));
    await claim(A);
    expect(existsSync(exitRequestPath(lockPath))).toBe(false);
  });

  it('fails when the running cockpit does not exit in time, naming its pid and how to end it', async () => {
    await claim(A);
    await expect(claim(B, () => {}, 100)).rejects.toThrow(/pid 1001 did not exit within 0.1 s .*kill 1001 \(docs\/recovery\.md\)/);
    expect(parseHolder(readLockFile(lockPath))).toEqual(A);
    // The request is withdrawn: B lives on without the lock, and A's next wake-up is a reload, not an exit.
    expect(exitRequested(lockPath, A, isRunning)).toBe(false);
  });

  it('waits for a lock that is being written, and takes over one left broken long ago', async () => {
    writeFileSync(lockPath, '');
    await expect(claim(B, () => {}, 60)).rejects.toThrow(/did not exit/);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath, old, old);
    const claimed = await claim(B);
    expect(claimed.replaced).toBeNull();
    expect(parseHolder(readLockFile(lockPath))).toEqual(B);
  });
});

describe('exitRequested', () => {
  it('is true only for a request from another running cockpit', () => {
    expect(exitRequested(lockPath, A, isRunning)).toBe(false);
    writeFileSync(exitRequestPath(lockPath), JSON.stringify(B));
    expect(exitRequested(lockPath, A, isRunning)).toBe(true);
    expect(exitRequested(lockPath, B, isRunning)).toBe(false); // its own
    running.delete(key(B));
    expect(exitRequested(lockPath, A, isRunning)).toBe(false); // the requester is gone
    writeFileSync(exitRequestPath(lockPath), 'not json');
    expect(exitRequested(lockPath, A, isRunning)).toBe(false);
  });
});

describe('parseHolder', () => {
  it('reads a pid and a start time, nothing else', () => {
    expect(parseHolder('{"pid":12,"start":"proc:5","nonce":"x"}\n')).toEqual({ pid: 12, start: 'proc:5' });
    expect(parseHolder(null)).toBeNull();
    expect(parseHolder('')).toBeNull();
    expect(parseHolder('{"pid":0,"start":"proc:5"}')).toBeNull();
    expect(parseHolder('{"pid":12,"start":""}')).toBeNull();
    expect(parseHolder('{"pid":"12","start":"x"}')).toBeNull();
  });
});
