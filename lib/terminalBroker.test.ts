import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, withEventDbTransaction } from './eventLog.ts';
import { commitClaims } from './runStore.ts';
import { ControlClient } from './controlClient.ts';
import { startControlServer, type ControlServer } from './controlServer.ts';
import { TerminalBroker, TmuxTerminalDriver, type TerminalDriver } from './terminalBroker.ts';

const exec = promisify(execFile);
const repoRoot = join(import.meta.dirname, '..');
let dir: string;
let server: ControlServer;
let broker: TerminalBroker;
let driver: FakeDriver;
let worktree: string;

class FakeDriver implements TerminalDriver {
  live = new Set(['tmux:worker-a']);
  writes: Array<{ handle: string; data: string }> = [];
  sizes: Array<{ handle: string; columns: number; rows: number }> = [];
  logs = new Map<string, string>();
  startShell(handle: string, cwd: string, logPath: string): void {
    expect(cwd).toBe(worktree);
    this.live.add(handle);
    this.logs.set(handle, logPath);
    writeFileSync(logPath, 'shell started\n');
  }
  alive(handle: string): boolean { return this.live.has(handle); }
  capture(handle: string): string { return `screen:${handle}\n`; }
  input(handle: string, data: string): void {
    this.writes.push({ handle, data });
    const log = this.logs.get(handle);
    if (log) appendFileSync(log, data);
  }
  resize(handle: string, columns: number, rows: number): void { this.sizes.push({ handle, columns, rows }); }
  stop(handle: string): void { this.live.delete(handle); }
}

beforeEach(async () => {
  dir = createTempStateDir('orch-terminal-');
  worktree = join(dir, 'worktree');
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), 'gitdir: dummy');
  seedState(dir);
  initEventsDb(dir);
  commitClaims(dir, { version: '1', claims: [
    { run_id: 'run-a', task_ref: 'orch/a', agent_id: 'worker-a', state: 'in_progress', claimed_at: '2026-01-01', started_at: '2026-01-01', lease_expires_at: '2099-01-01' },
    { run_id: 'run-b', task_ref: 'orch/b', agent_id: 'worker-b', state: 'in_progress', claimed_at: '2026-01-01', started_at: '2026-01-01', lease_expires_at: '2099-01-01' },
  ] });
  withEventDbTransaction(dir, (db) => {
    db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, transport, started_at, updated_at)
      VALUES ('session-a', 'run-a', 'worker-a', 'claude', 'running', 'tmux', '2026-01-01', '2026-01-01'),
        ('session-b', 'run-b', 'worker-b', 'codex', 'running', 'app-server', '2026-01-01', '2026-01-01')`).run();
  });
  driver = new FakeDriver();
  broker = new TerminalBroker(dir, { driver, worktreeForRun: () => worktree });
  server = await startControlServer(dir, { terminals: broker });
});

afterEach(async () => {
  await server.close();
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

describe('terminal broker', () => {
  it('lets another process observe a provider without acquiring input or ending the session', async () => {
    const observer = new ControlClient(dir);
    const terminal = (await observer.openTerminal('provider', 'run-a')).terminal;
    expect((await observer.observeTerminal(terminal.terminal_id)).screen).toContain('screen:tmux:worker-a');
    const child = await exec(process.execPath, ['cli/terminal.ts', 'provider', 'run-a', '--once'], {
      cwd: repoRoot, env: { ...process.env, ORC_STATE_DIR: dir, ORC_REPO_ROOT: dir }, encoding: 'utf8',
    });
    expect(child.stdout).toContain('screen:tmux:worker-a');
    expect(driver.live.has('tmux:worker-a')).toBe(true);
  });

  it('grants one writer at a time, requires its lease for input and resize, and expires abandoned leases', async () => {
    const first = new ControlClient(dir);
    const second = new ControlClient(dir);
    const id = (await first.openTerminal('provider', 'run-a')).terminal.terminal_id;
    const lease = await first.acquireTerminal(id, 'first');
    await expect(second.acquireTerminal(id, 'second')).rejects.toMatchObject({ code: 'conflict' });
    await expect(second.inputTerminal(id, 'wrong', 'x')).rejects.toMatchObject({ code: 'forbidden' });
    await first.inputTerminal(id, lease.lease_id, 'a');
    await first.resizeTerminal(id, lease.lease_id, 100, 40);
    expect(driver.writes).toEqual([{ handle: 'tmux:worker-a', data: 'a' }]);
    expect(driver.sizes).toEqual([{ handle: 'tmux:worker-a', columns: 100, rows: 40 }]);
    withEventDbTransaction(dir, (db) => db.prepare("UPDATE control_leases SET expires_at = '2000-01-01' WHERE resource_id = ?").run(id));
    const replacement = await second.acquireTerminal(id, 'second');
    await expect(first.inputTerminal(id, lease.lease_id, 'b')).rejects.toMatchObject({ code: 'forbidden' });
    await second.releaseTerminal(id, replacement.lease_id);
    expect(driver.live.has('tmux:worker-a')).toBe(true);
    await expect(first.acquireTerminal(id, 'first')).resolves.toHaveProperty('lease_id');
  });

  it('keeps an independent shell usable for a structured run after broker restart', async () => {
    const client = new ControlClient(dir);
    await expect(client.openTerminal('provider', 'run-b')).rejects.toMatchObject({ code: 'conflict' });
    const terminal = (await client.openTerminal('shell', 'run-b')).terminal;
    const lease = await client.acquireTerminal(terminal.terminal_id, 'operator');
    await client.inputTerminal(terminal.terminal_id, lease.lease_id, 'pwd\r');
    await client.releaseTerminal(terminal.terminal_id, lease.lease_id);
    const restarted = new TerminalBroker(dir, { driver, worktreeForRun: () => worktree });
    const view = restarted.observe(terminal.terminal_id);
    expect(view.output).toContain('pwd\r');
    expect(view.terminal.worktree_path).toBe(worktree);
    expect(driver.live.has('shell:run-b')).toBe(true);
    const oldLease = await client.acquireTerminal(terminal.terminal_id, 'old-writer');
    driver.live.delete('shell:run-b');
    await client.openTerminal('shell', 'run-b');
    await expect(client.inputTerminal(terminal.terminal_id, oldLease.lease_id, 'x')).rejects.toMatchObject({ code: 'forbidden' });
    withEventDbTransaction(dir, (db) => db.prepare("UPDATE runs SET state = 'done' WHERE run_id = 'run-b'").run());
    restarted.reconcile();
    expect(driver.live.has('shell:run-b')).toBe(false);
    expect(restarted.observe(terminal.terminal_id).terminal.state).toBe('offline');
    await expect(client.openTerminal('shell', 'run-b')).rejects.toMatchObject({ code: 'conflict' });
    expect(driver.live.has('shell:run-b')).toBe(false);
  });
});

describe.runIf(process.env.ORC_TMUX_SMOKE === '1')('real tmux terminal smoke', () => {
  it('keeps a shell attached across driver instances, resizes it, and stops only that shell', async () => {
    const real = new TmuxTerminalDriver(dir);
    const handle = 'shell:smoke-run';
    const logPath = join(dir, 'tmux-smoke.log');
    real.startShell(handle, worktree, logPath);
    try {
      expect(real.alive(handle)).toBe(true);
      real.resize(handle, 110, 32);
      real.input(handle, 'pwd\r');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(new TmuxTerminalDriver(dir).capture(handle)).toContain(worktree);
    } finally {
      real.stop(handle);
    }
    expect(real.alive(handle)).toBe(false);
  });
});
