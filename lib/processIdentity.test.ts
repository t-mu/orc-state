import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isPidAlive, isSameProcess, isZombie, isZombiePsStat, parseProcStatState, processIdentity, readProcessStart } from './processIdentity.ts';

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

describe('zombie detection', () => {
  it('reads the state field after a command name with spaces and parentheses', () => {
    expect(parseProcStatState('1348 (node) Z 1 1348 1348 0 -1')).toBe('Z');
    expect(parseProcStatState('1348 (my (odd) name) Z 1 1348 1348 0 -1')).toBe('Z');
    expect(parseProcStatState('42 (a) b) S 1 42')).toBe('S');
    expect(parseProcStatState('garbage')).toBeNull();
    expect(parseProcStatState('42 (x)')).toBeNull();
  });

  it('recognises a zombie in ps stat output', () => {
    expect(isZombiePsStat('Zs\n')).toBe(true);
    expect(isZombiePsStat(' Z+')).toBe(true);
    expect(isZombiePsStat('Ss')).toBe(false);
    expect(isZombiePsStat('')).toBe(false);
  });

  it('treats a live, a missing and an invalid PID as not a zombie', () => {
    expect(isZombie(process.pid)).toBe(false);
    expect(isZombie(0)).toBe(false);
    expect(isZombie(2 ** 22 + 12345)).toBe(false);
  });

  it.runIf(existsSync('/proc/self/stat'))('detects an exited child its parent has not reaped', async () => {
    // sh backgrounds a short sleep, then execs a long one, which never reaps the short one once it exits.
    const parent = spawn('sh', ['-c', 'sleep 0.5 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const pid = Number(await new Promise<string>((resolve) => parent.stdout.once('data', (d) => resolve(String(d).trim()))));
      for (let i = 0; i < 100 && !isZombie(pid); i++) await new Promise((r) => setTimeout(r, 50));
      expect(isPidAlive(pid)).toBe(true);
      expect(isZombie(pid)).toBe(true);
    } finally {
      parent.kill('SIGKILL');
    }
  }, 10_000);
});
