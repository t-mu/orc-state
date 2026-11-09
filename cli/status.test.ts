import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { renderBanner } from '../lib/banner.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let root: string;
let dir: string;

beforeEach(() => {
  root = createTempStateDir('orch-status-cli-test-');
  dir = join(root, '.orc-state');
  mkdirSync(dir);
});

afterEach(() => {
  cleanupTempStateDir(root);
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
    expect(json.claims.waiting_input).toBe(0);
    // Same coordinator fields as MCP get_status; none runs for a temp state directory.
    expect(json.coordinator).toEqual({ running: false, pid: null, version: null, started_at: null, stale: null });
  });

  it('prints compact one-line json and no banner when stdout is piped', () => {
    seedValidState({ tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }] });
    const json = runStatus(['--json']);
    expect(json.status).toBe(0);
    expect(json.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(json.stdout).tasks.total).toBe(1);

    const text = runStatus([]);
    expect(text.status).toBe(0);
    const bannerFirstLine = stripVTControlCharacters(renderBanner().split('\n')[0]);
    expect(bannerFirstLine.trim().length).toBeGreaterThan(0);
    expect(stripVTControlCharacters(text.stdout)).not.toContain(bannerFirstLine);
  });

  it('honors --events <n> given as a separate argument', () => {
    seedValidState();
    for (let i = 0; i < 8; i++) {
      appendSequencedEvent(dir, { ts: '2026-01-01T00:00:00Z', event: 'heartbeat', actor_type: 'agent', actor_id: 'w', run_id: `run-${i}`, task_ref: 'docs/task-1', agent_id: 'w', payload: {} } as never);
    }
    const result = runStatus(['--events', '5', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).recentEvents).toHaveLength(5);
  });

  it('rejects unknown flags as a usage error', () => {
    seedValidState();
    const result = runStatus(['--bogus']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc status');
  });

  it('prints one escape-free JSON frame for --json --once', () => {
    seedValidState();
    const result = runStatus(['--json', '--once']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('\x1b');
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).tasks.total).toBe(1);
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
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }],
      // A run blocked in finalization without a reason (two active runs for one task cannot be stored).
      claims: [
        {
          run_id: 'run-old',
          task_ref: 'docs/task-1',
          agent_id: 'orc-1',
          state: 'in_progress',
          claimed_at: '2026-01-01T00:00:00Z',
          lease_expires_at: '2099-01-01T00:00:00Z',
          finalization_state: 'blocked_finalize',
        },
      ],
    });
    const result = runStatus([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Orchestrator Status');
    expect(result.stderr).toContain('State validation warnings:');
    expect(result.stderr).toContain('claim run-old is blocked_finalize without a blocked reason');
  });

  it('prints human-readable status output', () => {
    seedValidState({
      agents: [
        { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
        { agent_id: 'scout-1', provider: 'codex', role: 'scout', status: 'running', session_handle: 'tmux:scout-1', registered_at: '2026-01-01T00:00:00Z' },
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
    expect(result.stdout).toContain('Scouts (1):');
    expect(result.stdout).toMatch(/scout-1\s+running\s+attached/);
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
    expect(result.stderr).toContain('--mine requires --agent-id');
    expect(result.stderr).toContain('Usage: orc status');
  });

  it('--watch --once renders one frame with update footer and no clear-screen codes when piped', () => {
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
    expect(result.stdout).not.toContain('\x1b');
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
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }],
      // A run blocked in finalization without a reason (two active runs for one task cannot be stored).
      claims: [
        {
          run_id: 'run-old',
          task_ref: 'docs/task-1',
          agent_id: 'orc-1',
          state: 'in_progress',
          claimed_at: '2026-01-01T00:00:00Z',
          lease_expires_at: '2099-01-01T00:00:00Z',
          finalization_state: 'blocked_finalize',
        },
      ],
    });
    const result = runStatus(['--watch', '--once']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Orchestrator Status');
    expect(result.stdout).toContain('State validation warnings:');
    expect(result.stdout).toContain('claim run-old is blocked_finalize without a blocked reason');
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
  return spawnSync('node', ['cli/status.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: dir, ORC_MAX_WORKERS: '2', ORC_WORKER_PROVIDER: 'codex' },
    encoding: 'utf8',
  });
}

function seedValidState({
  tasks = [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }] as unknown[],
  agents = [] as unknown[],
  claims = [] as unknown[],
  runWorktrees = [] as unknown[],
} = {}) {
  seedState(dir, { tasks, agents, claims });
  writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({ version: '1', runs: runWorktrees }));
}
