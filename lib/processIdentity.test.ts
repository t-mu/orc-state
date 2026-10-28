import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { isPidAlive, isSameProcess, processIdentity, readProcessStart } from './processIdentity.ts';

describe('process identity', () => {
  it('fingerprints a live process stably', () => {
    const identity = processIdentity(process.pid);
    expect(identity?.pid).toBe(process.pid);
    expect(readProcessStart(process.pid)).toBe(identity?.start);
    expect(isSameProcess(identity!)).toBe(true);
  });

  it('treats a reused PID with a different start time as a different process', () => {
    expect(isSameProcess({ pid: process.pid, start: 'proc:1' })).toBe(false);
  });

  it('still recognises a ps fingerprint recorded before readings were normalised', () => {
    const lstart = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim();
    expect(isSameProcess({ pid: process.pid, start: `ps:${lstart}` })).toBe(true);
    expect(isSameProcess({ pid: process.pid, start: 'ps:Thu Jan  1 00:00:00 1970' })).toBe(false);
  });

  it('reports an exited process as gone', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    const identity = processIdentity(child.pid!);
    expect(identity).not.toBeNull();
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    spawnSync('true');
    expect(isPidAlive(child.pid!)).toBe(false);
    expect(isSameProcess(identity!)).toBe(false);
    expect(readProcessStart(child.pid!)).toBeNull();
    expect(isPidAlive(0)).toBe(false);
  });
});
