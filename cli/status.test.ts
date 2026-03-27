import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orch-status-cli-test-'));
  dir = join(root, '.orc-state');
  mkdirSync(dir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('cli/status.ts', () => {
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

  it('survives malformed events log by skipping corrupted rows', () => {
    seedValidState();
    writeFileSync(join(dir, 'events.jsonl'), '{"seq":1}\nnot-json\n');
    const result = runStatus([]);
    expect(result.status).toBe(0);
  });

  it('renders status and surfaces lifecycle invariant warnings without failing', () => {
    seedValidState({
      agents: [
        { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
        { agent_id: 'orc-2', provider: 'codex', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
      ],
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }],
      claims: [
        {
          run_id: 'run-old',
          task_ref: 'docs/task-1',
          agent_id: 'orc-1',
          state: 'claimed',
          claimed_at: '2026-01-01T00:00:00Z',
          lease_expires_at: '2099-01-01T00:00:00Z',
        },
        {
          run_id: 'run-new',
          task_ref: 'docs/task-1',
          agent_id: 'orc-2',
          state: 'claimed',
          claimed_at: '2026-01-01T00:05:00Z',
          lease_expires_at: '2099-01-01T00:00:00Z',
        },
      ],
    });
    const result = runStatus([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Orchestrator Status');
    expect(result.stderr).toContain('State validation warnings:');
    expect(result.stderr).toContain('keep oldest run run-old');
  });

  it('prints human-readable status output', () => {
    seedValidState({
      agents: [
        { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
        { agent_id: 'scout-1', provider: 'codex', role: 'scout', status: 'running', session_handle: 'pty:scout-1', registered_at: '2026-01-01T00:00:00Z' },
      ],
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }],
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
    expect(result.stdout).toContain('scout-1');
    expect(result.stdout).toContain('scout    investigating');
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
    expect(json.queued_tasks.every((task: Record<string, unknown>) => task.ref !== 'docs/task-2')).toBe(true);
  });

  it('fails when --mine is passed without --agent-id', () => {
    seedValidState();
    const result = runStatus(['--mine']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc-status --mine --agent-id=<id> [--json]');
  });

  it('--watch --once renders one frame with ANSI clear and update footer', () => {
    seedValidState({
      agents: [
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
    const result = runStatus(['--watch', '--once']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('\x1b[2J\x1b[H');
    expect(result.stdout).toContain('Orchestrator Status');
    expect(result.stdout).toContain('watch interval:');
    expect(result.stdout).toContain('updated at:');
  });

  it('--watch --once exits 1 when state is invalid', () => {
    // empty dir — no state files seeded
    const result = runStatus(['--watch', '--once']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('State validation failed');
  });

  it('--watch --once renders with warnings when lifecycle invariants are broken', () => {
    seedValidState({
      agents: [
        { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
        { agent_id: 'orc-2', provider: 'codex', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
      ],
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }],
      claims: [
        {
          run_id: 'run-old',
          task_ref: 'docs/task-1',
          agent_id: 'orc-1',
          state: 'claimed',
          claimed_at: '2026-01-01T00:00:00Z',
          lease_expires_at: '2099-01-01T00:00:00Z',
        },
        {
          run_id: 'run-new',
          task_ref: 'docs/task-1',
          agent_id: 'orc-2',
          state: 'claimed',
          claimed_at: '2026-01-01T00:05:00Z',
          lease_expires_at: '2099-01-01T00:00:00Z',
        },
      ],
    });
    const result = runStatus(['--watch', '--once']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Orchestrator Status');
    expect(result.stdout).toContain('State validation warnings:');
    expect(result.stdout).toContain('keep oldest run run-old');
  });

  it('-w --once is equivalent to --watch --once', () => {
    seedValidState();
    const result = runStatus(['-w', '--once']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('watch interval:');
    expect(result.stdout).toContain('updated at:');
  });

  it('--watch --once respects --interval-ms in footer', () => {
    seedValidState();
    const result = runStatus(['--watch', '--once', '--interval-ms=2000']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('watch interval: 2000ms');
  });
});

function runStatus(args: string[]) {
  return spawnSync('node', ['--experimental-strip-types', 'cli/status.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedValidState({
  tasks = [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }] as unknown[],
  agents = [] as unknown[],
  claims = [] as unknown[],
  runWorktrees = [] as unknown[],
} = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'docs', title: 'Docs', tasks }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({ version: '1', runs: runWorktrees }));
  writeFileSync(join(dir, 'events.jsonl'), '');
  writeFileSync(join(root, 'orchestrator.config.json'), JSON.stringify({
    worker_pool: { max_workers: 2, provider: 'codex' },
  }));
}
