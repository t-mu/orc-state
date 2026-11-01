import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  controlEndpointCoordinatorPid, coordinatorPidFileProblem, findLiveCoordinator, isCoordinatorLockHeld,
  isCoordinatorProcess, runningCoordinatorPid,
} from './coordinatorLiveness.ts';
import { readProcessStart } from './processIdentity.ts';

describe('isCoordinatorLockHeld', () => {
  it('holds only while the recorded process, not just its PID, is alive', () => {
    expect(isCoordinatorLockHeld({ pid: process.pid, process_start: readProcessStart(process.pid) })).toBe(true);
    expect(isCoordinatorLockHeld({ pid: process.pid, process_start: 'proc:0' })).toBe(false);
    // A lock written before process_start was recorded falls back to the PID.
    expect(isCoordinatorLockHeld({ pid: process.pid })).toBe(true);
    expect(isCoordinatorLockHeld({ pid: 'x' })).toBe(false);
    expect(isCoordinatorLockHeld(null)).toBe(false);
  });
});

describe('coordinator discovery', () => {
  let dir: string;
  let fake: ChildProcess;

  /** A live process whose command line runs a script named coordinator.js. */
  async function startFakeCoordinator(): Promise<ChildProcess> {
    const script = join(dir, 'coordinator.js');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    return child;
  }

  function writeEndpoint(pid: number, extra: Record<string, unknown> = {}) {
    writeFileSync(join(dir, 'control.json'), JSON.stringify({
      protocol_version: 1, transport: 'unix', path: join(dir, 'control.sock'), pid,
      started_at: '2026-11-01T00:00:00.000Z', process_start: readProcessStart(pid), ...extra,
    }));
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-coord-liveness-'));
    fake = await startFakeCoordinator();
  });

  afterEach(() => {
    fake.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('recognises a coordinator command line and rejects other processes', () => {
    expect(isCoordinatorProcess(fake.pid!)).toBe(true);
    expect(isCoordinatorProcess(process.pid)).toBe(false);
  });

  it('finds a live coordinator through control.json when coordinator.pid is missing', () => {
    writeEndpoint(fake.pid!);
    expect(findLiveCoordinator(dir)).toEqual({ pid: fake.pid, source: 'control_json' });
    expect(runningCoordinatorPid(dir)).toBe(fake.pid);
    expect(coordinatorPidFileProblem(dir)).toMatch(/coordinator\.pid is missing/);
  });

  it('accepts an endpoint written before process_start was recorded', () => {
    writeEndpoint(fake.pid!, { process_start: undefined });
    expect(controlEndpointCoordinatorPid(dir)).toBe(fake.pid);
  });

  it('ignores control.json naming a reused PID or a dead PID', () => {
    // Reused PID: alive, but the start fingerprint differs.
    writeEndpoint(fake.pid!, { process_start: 'proc:0' });
    expect(findLiveCoordinator(dir)).toBeNull();
    // Reused PID: a live process that is not a coordinator.
    writeEndpoint(process.pid);
    expect(findLiveCoordinator(dir)).toBeNull();
    // Dead PID.
    writeEndpoint(fake.pid!);
    fake.kill('SIGKILL');
    writeFileSync(join(dir, 'control.json'), JSON.stringify({ pid: 999999999, started_at: 'x', process_start: 'proc:1' }));
    expect(findLiveCoordinator(dir)).toBeNull();
    expect(coordinatorPidFileProblem(dir)).toBeNull();
  });

  it('prefers coordinator.pid when both files agree, and reports no problem', () => {
    writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: fake.pid, started_at: 'x', process_start: readProcessStart(fake.pid!) }));
    writeEndpoint(fake.pid!);
    expect(findLiveCoordinator(dir)).toEqual({ pid: fake.pid, source: 'pid_file' });
    expect(coordinatorPidFileProblem(dir)).toBeNull();
  });

  it('flags a coordinator.pid naming a different pid', () => {
    writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 999999999, started_at: 'x' }));
    writeEndpoint(fake.pid!);
    expect(findLiveCoordinator(dir)).toEqual({ pid: fake.pid, source: 'control_json' });
    expect(coordinatorPidFileProblem(dir)).toMatch(/names PID 999999999/);
  });
});
