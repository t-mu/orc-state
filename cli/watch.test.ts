import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ProjectWatcher, type ProjectListEntry } from '../client.ts';
import { startControlServer } from '../lib/controlServer.ts';
import { closeAllDatabases } from '../lib/eventLog.ts';
import { buildStatus } from '../lib/statusView.ts';
import { createTempStateDir, cleanupTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { runFallbackWatch, watchedProjectList, type WatchSource } from './watch.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;
let dataHome: string;

beforeEach(() => {
  dir = createTempStateDir('orch-watch-cli-test-');
  dataHome = mkdtempSync(join(tmpdir(), 'orch-watch-data-home-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  closeAllDatabases();
  cleanupTempStateDir(dir);
  rmSync(dataHome, { recursive: true, force: true });
});

describe('cli/watch.ts', () => {
  it('shows the project as stopped in --once mode when no coordinator runs, without reading its state', () => {
    seedValidState();
    const result = runCli(['--once']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('coordinator: stopped (coordinator not running)');
    expect(result.stdout).toContain(`project: ${dir.split('/').at(-1)}`);
    // The status sections come only from a coordinator's /v1/status.
    expect(result.stdout).not.toContain('Worker Capacity:');
    expect(result.stdout).toContain('watch interval:');
    expect(result.stderr).not.toContain('State validation failed');
  });

  it('shows a stopped project even when its state files are missing', () => {
    const result = runCli(['--once']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('coordinator: stopped');
  });

  it('renders the status it gets through orc-state/client from a running coordinator', async () => {
    seedValidState({
      agents: [
        { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
        { agent_id: 'scout-1', provider: 'codex', role: 'scout', status: 'running', session_handle: 'tmux:scout-1', registered_at: '2026-01-01T00:00:00Z' },
      ],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
        finalization_state: 'awaiting_finalize',
        finalization_retry_count: 0,
      }],
      runWorktrees: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'orc-1',
        branch: 'task/run-1',
        worktree_path: '/tmp/orc-worktrees/run-1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }],
    });
    const server = await startControlServer(dir, { socketPath: join(dataHome, 'c.sock') });
    try {
      // The registry's liveness check needs a coordinator process; this one is the test's control server.
      const source = new ProjectWatcher({ listProjects: () => [entry(dir, true)] });
      const { code, out } = await captureStdout(() => runFallbackWatch({ once: true, intervalMs: 1000, stateDir: dir, source }));
      expect(code).toBe(0);
      expect(out).toContain('Orchestrator Status');
      expect(out).toContain('Worker Capacity:');
      expect(out).toMatch(/scout-1\s+running\s+attached/);
      expect(out).toContain('Scouts (1):');
      expect(out).toContain('Master:');
      expect(out).toContain('Finalization (1):');
      expect(out).toContain('awaiting_finalize:        1');
      expect(out).toContain('coordinator: running');
    } finally {
      await server.close();
    }
  });

  it('exits 1 in --once mode when the coordinator does not answer', async () => {
    const source = new ProjectWatcher({
      listProjects: () => [entry(dir, true)],
      backoff: { initialMs: 60_000 },
    });
    const { code, out } = await captureStdout(() => runFallbackWatch({ once: true, intervalMs: 1000, stateDir: dir, source }));
    expect(code).toBe(1);
    expect(out).toMatch(/coordinator: unreachable: /);
  });

  it('lists the other watched projects with their connection', async () => {
    const source = fakeSource([
      { project: entry(dir, false), connection: 'stopped', error: null, status: null, cursor: null },
      { project: { ...entry('/state/other', false), name: 'other' }, connection: 'stopped', error: null, status: null, cursor: null },
    ]);
    const { code, out } = await captureStdout(() => runFallbackWatch({ once: true, intervalMs: 1000, stateDir: dir, source }));
    expect(code).toBe(0);
    expect(out).toContain('Other projects (1):');
    expect(out).toMatch(/other\s+stopped/);
  });

  it('renders after the settle timeout while the project is still connecting, exiting 1', async () => {
    const source = fakeSource([{ project: entry(dir, true), connection: 'connecting', error: null, status: null, cursor: null }]);
    const { code, out } = await captureStdout(() => runFallbackWatch({ once: true, intervalMs: 1000, stateDir: dir, source, settleTimeoutMs: 20 }));
    expect(code).toBe(1);
    expect(out).toContain('coordinator: connecting');
  });

  it('keeps the last status of a project whose coordinator stopped, marked as last known', async () => {
    const status = { ...emptyStatus(), project: { id: 'p', name: 'demo', target_repo_root: '/repo' } };
    const source = fakeSource([{ project: entry(dir, false), connection: 'stopped', error: null, status: status as never, cursor: 1 }]);
    const { code, out } = await captureStdout(() => runFallbackWatch({ once: true, intervalMs: 1000, stateDir: dir, source }));
    expect(code).toBe(0);
    expect(out).toContain('Orchestrator Status');
    expect(out).toContain('coordinator: stopped (coordinator not running) (showing last known status)');
  });

  it('prints the registry error when the project is not watched because the registry cannot be read', async () => {
    const source = new ProjectWatcher({ listProjects: () => { throw new Error('registry.db schema version 9 is newer'); } });
    const { code, out } = await captureStdout(() => runFallbackWatch({ once: true, intervalMs: 1000, stateDir: dir, source }));
    expect(code).toBe(1);
    expect(out).toContain('registry error: registry.db schema version 9 is newer');
  });

  it('watches an unregistered state directory alongside the registered projects', () => {
    const registered = entry('/state/registered', false);
    const list = watchedProjectList(dir, () => [registered]);
    const listed = list();
    expect(listed.map((e) => e.state_dir)).toEqual(['/state/registered', dir]);
    expect(listed[1].coordinator_running).toBe(false);
    expect(watchedProjectList('/state/registered', () => [registered])()).toEqual([registered]);
  });
});

function entry(stateDir: string, running: boolean): ProjectListEntry {
  return {
    id: `id-${stateDir}`, name: stateDir.split('/').at(-1)!, target_repo_root: '/repo', state_dir: stateDir,
    repo_present: true, control_socket: null, coordinator_running: running,
  };
}

/** A /v1/status view of an empty project, built as the coordinator builds it. */
function emptyStatus(): ReturnType<typeof buildStatus> {
  seedValidState();
  return buildStatus(dir);
}

function fakeSource(states: ReturnType<WatchSource['projects']>): WatchSource {
  return { start: () => {}, stop: async () => {}, projects: () => states, onUpdate: () => () => {} };
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ code: T; out: string }> {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out += `${args.join(' ')}\n`; });
  try {
    const code = await fn();
    return { code, out };
  } finally {
    vi.restoreAllMocks();
  }
}

function seedValidState({ agents = [] as unknown[], claims = [] as unknown[], runWorktrees = [] as unknown[] } = {}) {
  seedState(dir, {
    tasks: [{ ref: 'docs/task-1', title: 'Task', status: 'in_progress' }],
    agents: [
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
      ...agents,
    ],
    claims,
  });
  writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({ version: '1', runs: runWorktrees }));
}

function runCli(args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_')));
  return spawnSync('node', ['cli/watch.ts', ...args], {
    cwd: repoRoot,
    env: { ...env, ORC_DATA_HOME: dataHome, ORC_STATE_DIR: dir, ORC_MAX_WORKERS: '2', ORC_WORKER_PROVIDER: 'codex' },
    encoding: 'utf8',
  });
}
