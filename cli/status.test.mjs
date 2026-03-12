import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-status-cli-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli/status.mjs', () => {
  it('prints json status with agent/task/claim counts', () => {
    seedValidState({
      agents: [
        { agent_id: 'master', provider: 'codex', role: 'master', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
        { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
      ],
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    });
    const result = runStatus(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.master.agent_id).toBe('master');
    expect(json.tasks.total).toBe(1);
    expect(json.claims.total).toBe(1);
  });

  it('fails with actionable parse error for malformed events log', () => {
    seedValidState();
    writeFileSync(join(dir, 'events.jsonl'), '{"seq":1}\nnot-json\n');
    const result = runStatus([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('State validation failed');
    expect(result.stderr).toContain('events.jsonl schema error at line 1');
  });

  it('prints human-readable status output', () => {
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
        finalization_state: 'blocked_finalize',
        finalization_retry_count: 2,
        finalization_blocked_reason: 'preserved for review',
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
    const result = runStatus([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Orchestrator Status');
    expect(result.stdout).toContain('Worker Capacity:');
    expect(result.stdout).toContain('Finalization (1):');
    expect(result.stdout).toContain('blocked_preserved:        1');
    expect(result.stdout).toContain('task/run-1');
  });

  it('prints only agent-scoped work for --mine --agent-id', () => {
    seedValidState({
      agents: [
        { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
        { agent_id: 'orc-2', provider: 'codex', role: 'worker', status: 'idle', registered_at: '2026-01-01T00:00:00Z' },
      ],
      tasks: [
        { ref: 'docs/task-1', title: 'Task 1', status: 'claimed', owner: 'orc-1' },
        { ref: 'docs/task-2', title: 'Task 2', status: 'todo', owner: 'orc-2' },
      ],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'orc-1',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    });
    const result = runStatus(['--mine', '--agent-id=orc-1', '--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.agent.agent_id).toBe('orc-1');
    expect(json.assigned_tasks).toHaveLength(1);
    expect(json.queued_tasks.every((task) => task.ref !== 'docs/task-2')).toBe(true);
  });

  it('fails when --mine is passed without --agent-id', () => {
    seedValidState();
    const result = runStatus(['--mine']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc-status --mine --agent-id=<id> [--json]');
  });
});

function runStatus(args) {
  return spawnSync('node', ['cli/status.mjs', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedValidState({
  tasks = [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }],
  agents = [],
  claims = [],
  runWorktrees = [],
} = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    epics: [{ ref: 'docs', title: 'Docs', tasks }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({ version: '1', runs: runWorktrees }));
  writeFileSync(join(dir, 'events.jsonl'), '');
  writeFileSync(join(dir, 'orchestrator.config.json'), JSON.stringify({
    worker_pool: { max_workers: 2, provider: 'codex' },
  }));
}
