import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { classifySession, type SupervisedSession } from '../lib/sessionSupervisor.ts';
import { closeAllDatabases, initEventsDb, withEventDbTransaction } from '../lib/eventLog.ts';
import { TerminalBroker } from '../lib/terminalBroker.ts';

const exec = promisify(execFile);
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const fixtureBin = resolve(import.meta.dirname, '..', 'test-fixtures', 'bin');
const tmuxModule = resolve(import.meta.dirname, 'tmux.ts');

let dir: string;
let originalPath: string | undefined;
let originalStateDir: string | undefined;

async function loadAdapter() {
  vi.resetModules();
  const module = await import('./tmux.ts');
  return { module, adapter: module.createTmuxAdapter({ provider: 'gemini' }) };
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Launch a session from a separate "coordinator" process that then exits without stopping it. */
async function launchFromExitingProcess(agentId: string): Promise<{ session_handle: string; provider_ref: { pid: number; process_start: string } }> {
  const script = `
    const { createTmuxAdapter } = await import(${JSON.stringify(tmuxModule)});
    const result = await createTmuxAdapter({ provider: 'gemini' }).start(${JSON.stringify(agentId)}, { working_directory: ${JSON.stringify(dir)} });
    console.log(JSON.stringify(result));
    process.exit(0);
  `;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ORC_STATE_DIR: dir, PATH: `${fixtureBin}:${process.env.PATH}` },
  });
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as { session_handle: string; provider_ref: { pid: number; process_start: string } };
}

function record(ref: { pid: number; process_start: string }): SupervisedSession {
  return {
    session_id: 's-1', run_id: null, agent_id: 'worker-1', provider: 'gemini', state: 'running', transport: 'tmux',
    process_pid: ref.pid, process_start: ref.process_start, owner_id: 'pid:1:exited', owner_expires_at: null,
    state_reason: null, started_at: '', updated_at: '',
  };
}

describe.skipIf(!hasTmux)('tmux session transport', () => {
  beforeEach(() => {
    dir = createTempStateDir('orch-tmux-');
    originalPath = process.env.PATH;
    originalStateDir = process.env.ORC_STATE_DIR;
    process.env.ORC_STATE_DIR = dir;
    process.env.PATH = `${fixtureBin}:${originalPath}`;
  });

  afterEach(async () => {
    const { module } = await loadAdapter();
    spawnSync('tmux', ['-L', module.tmuxSocketName(dir), 'kill-server']);
    closeAllDatabases();
    process.env.PATH = originalPath;
    if (originalStateDir === undefined) delete process.env.ORC_STATE_DIR;
    else process.env.ORC_STATE_DIR = originalStateDir;
    cleanupTempStateDir(dir);
  });

  it('keeps a session alive and writable after the launching coordinator exits', async () => {
    const launched = await launchFromExitingProcess('worker-1');
    expect(launched.session_handle).toBe('tmux:worker-1');

    const { adapter } = await loadAdapter();
    const inspection = adapter.inspectSession(launched.session_handle);
    expect(inspection).toMatchObject({ transport: 'tmux', alive: true, writable: true, pid: launched.provider_ref.pid });
    expect(inspection.processStart).toBe(launched.provider_ref.process_start);
    expect(classifySession(record(launched.provider_ref), inspection).outcome).toBe('adopted');
    expect(adapter.ownsSession(launched.session_handle)).toBe(true);
    expect(adapter.survivesCoordinatorExit(launched.session_handle)).toBe(true);

    await adapter.send(launched.session_handle, 'PING');
    await waitFor(() => (adapter.getOutputTail(launched.session_handle) ?? '').includes('FIXTURE_PONG'));
    await expect(adapter.heartbeatProbe(launched.session_handle)).resolves.toBe(true);
  }, 20_000);

  it('shares the provider writer lease with the coordinator send path', async () => {
    const { adapter } = await loadAdapter();
    const started = await adapter.start('worker-1', { working_directory: dir });
    writeFileSync(join(dir, '.git'), 'gitdir: dummy');
    initEventsDb(dir);
    withEventDbTransaction(dir, (db) => {
      db.prepare(`INSERT INTO runs (run_id, task_ref, agent_id, state, created_at, updated_at)
        VALUES ('run-1', 'orch/task', 'worker-1', 'in_progress', 'now', 'now')`).run();
      db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, transport, started_at, updated_at)
        VALUES ('session-1', 'run-1', 'worker-1', 'gemini', 'running', 'tmux', 'now', 'now')`).run();
    });
    const broker = new TerminalBroker(dir, { worktreeForRun: () => dir });
    const terminal = broker.provider('run-1');
    const human = broker.acquire(terminal.terminal_id, 'human');
    await expect(adapter.send(started.session_handle, 'PING')).rejects.toThrow('Terminal already has a writer');
    broker.release(terminal.terminal_id, human.lease_id);
    const sending = adapter.send(started.session_handle, 'PING');
    expect(() => broker.acquire(terminal.terminal_id, 'human')).toThrow('Terminal already has a writer');
    await sending;
    expect(() => broker.acquire(terminal.terminal_id, 'human')).not.toThrow();
  }, 20_000);

  it('reports provider exit and supervisor loss as offline', async () => {
    const { adapter, module } = await loadAdapter();
    const first = await adapter.start('worker-1', { working_directory: dir });
    const ref = first.provider_ref as { pid: number; process_start: string };

    await adapter.send(first.session_handle, 'EXIT');
    await waitFor(() => !adapter.inspectSession(first.session_handle).alive);
    expect(classifySession(record(ref), adapter.inspectSession(first.session_handle)).state).toBe('offline');
    await expect(adapter.send(first.session_handle, 'PING')).rejects.toThrow('No live tmux session');

    const second = await adapter.start('worker-2', { working_directory: dir });
    expect(adapter.inspectSession(second.session_handle).alive).toBe(true);
    spawnSync('tmux', ['-L', module.tmuxSocketName(dir), 'kill-server']);
    expect(adapter.inspectSession(second.session_handle)).toMatchObject({ alive: false, reason: 'tmux session not found' });
    await expect(adapter.heartbeatProbe(second.session_handle)).resolves.toBe(false);
  }, 20_000);

  it('gives each session its own env without leaking it through the shared server', async () => {
    const { adapter } = await loadAdapter();
    const first = await adapter.start('worker.1', { working_directory: dir, env: { ORC_PROBE: 'first' } });
    const second = await adapter.start('worker_1', { working_directory: dir });
    // The launcher carried the session's environment; nothing of it is left behind (task 231).
    expect(existsSync(join(dir, 'pty-settings', 'worker.1.launch.sh'))).toBe(false);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('orc-launch-'))
      .some((name) => existsSync(join(tmpdir(), name, 'worker.1.launch.sh')))).toBe(false);
    // Similar agent IDs must not share (or kill) each other's session.
    expect(adapter.inspectSession(first.session_handle).alive).toBe(true);
    expect(adapter.inspectSession(second.session_handle).alive).toBe(true);
    const environ = (handle: string) => readFileSync(`/proc/${adapter.inspectSession(handle).pid}/environ`, 'utf8').split('\0');
    if (existsSync('/proc/self/environ')) {
      expect(environ(first.session_handle)).toContain('ORC_PROBE=first');
      expect(environ(second.session_handle).some((entry) => entry.startsWith('ORC_PROBE='))).toBe(false);
    }
  }, 20_000);

  it('starts the provider in the assigned worktree, not ORC_REPO_ROOT (task 204)', async () => {
    const worktree = join(dir, 'worktrees', 'run-1');
    mkdirSync(worktree, { recursive: true });
    const { adapter } = await loadAdapter();
    const started = await adapter.start('worker-1', { working_directory: worktree, env: { ORC_REPO_ROOT: dir } });
    // Reported by the provider itself on startup, before any instruction is sent.
    await waitFor(() => (adapter.getOutputTail(started.session_handle) ?? '').includes('FIXTURE_CWD'));
    expect(adapter.getOutputTail(started.session_handle)).toContain(`FIXTURE_CWD ${realpathSync(worktree)}`);
    if (existsSync('/proc/self/cwd')) {
      expect(readlinkSync(`/proc/${adapter.inspectSession(started.session_handle).pid}/cwd`)).toBe(realpathSync(worktree));
    }
  }, 20_000);

  it('stop() ends the session and its provider process', async () => {
    const { adapter } = await loadAdapter();
    const started = await adapter.start('worker-1', { working_directory: dir });
    const pid = (started.provider_ref as { pid: number }).pid;
    await adapter.stop(started.session_handle);
    await waitFor(() => spawnSync('kill', ['-0', String(pid)]).status !== 0);
    expect(adapter.inspectSession(started.session_handle).alive).toBe(false);
    expect(join(dir, 'pty-logs', 'worker-1.log')).toBeTruthy();
  }, 20_000);
});
