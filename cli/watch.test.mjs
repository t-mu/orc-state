import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-watch-cli-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli/watch.ts', () => {
  it('renders one snapshot in --once mode for valid state', () => {
    seedValidState({
      agents: [
        { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
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
    const result = runCli(['--once']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Worker Capacity:');
    expect(result.stdout).toContain('Master:');
    expect(result.stdout).toContain('Finalization (1):');
    expect(result.stdout).toContain('awaiting_finalize:        1');
    expect(result.stdout).toContain('watch interval:');
  });

  it('fails in --once mode when state is invalid', () => {
    // missing required files => validation fails
    const result = runCli(['--once']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('State validation failed');
  });
});

function seedValidState({ agents = [], claims = [], runWorktrees = [] } = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    epics: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: 'docs/task-1', title: 'Task', status: 'todo' }] }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
      ...agents,
    ],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({ version: '1', runs: runWorktrees }));
  writeFileSync(join(dir, 'events.jsonl'), '');
  writeFileSync(join(dir, 'orchestrator.config.json'), JSON.stringify({
    worker_pool: { max_workers: 2, provider: 'codex' },
  }));
}

function runCli(args) {
  return spawnSync('node', ['--experimental-strip-types', 'cli/watch.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}
