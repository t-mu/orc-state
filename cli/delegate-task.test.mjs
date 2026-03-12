import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-delegate-test-'));
  seedState();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli/delegate-task.ts', () => {
  it('marks task ready_for_dispatch and emits task_delegated event', () => {
    const result = runCli([
      '--task-ref=docs/task-1',
      '--target-agent-id=worker-01',
      '--task-type=implementation',
      '--note=please execute',
    ]);
    expect(result.status).toBe(0);
    const task = readBacklog().epics[0].tasks[0];
    expect(task.owner).toBe('worker-01');
    expect(task.planning_state).toBe('ready_for_dispatch');
    expect(task.delegated_by).toBe('human');
    const taskDelegatedEvent = readEvents().find((e) => e.event === 'task_delegated');
    expect(taskDelegatedEvent).toBeDefined();
    expect(taskDelegatedEvent?.actor_type).toBe('human');
    expect(taskDelegatedEvent?.actor_id).toBe('human');
    expect(taskDelegatedEvent?.payload?.planner_id).toBeUndefined();
  });

  it('uses non-human actor identity when --actor-id is provided', () => {
    const result = runCli([
      '--task-ref=docs/task-1',
      '--target-agent-id=worker-01',
      '--task-type=implementation',
      '--actor-id=worker-01',
    ]);
    expect(result.status).toBe(0);
    const task = readBacklog().epics[0].tasks[0];
    expect(task.delegated_by).toBe('worker-01');
    const event = readEvents().find((e) => e.event === 'task_delegated');
    expect(event?.actor_type).toBe('agent');
    expect(event?.actor_id).toBe('worker-01');
  });

  it('auto-assigns matching refactor-capable target when none provided', () => {
    const result = runCli([
      '--task-ref=docs/task-1',
      '--task-type=refactor',
    ]);
    expect(result.status).toBe(0);
    const task = readBacklog().epics[0].tasks[0];
    expect(task.owner).toBe('worker-01');
  });

  it('fails when actor-id is invalid format', () => {
    const result = runCli(['--task-ref=docs/task-1', '--actor-id=INVALID']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid actor-id');
  });

  it('fails when actor-id is non-human but not registered', () => {
    const result = runCli(['--task-ref=docs/task-1', '--actor-id=missing-agent']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Actor agent not found');
  });

  it('rejects unsupported task types', () => {
    const result = runCli([
      '--task-ref=docs/task-1',
      '--task-type=review',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid task type');
  });

  it('allows delegation without target when no eligible agent exists', () => {
    const result = runCli([
      '--task-ref=docs/task-1',
      '--task-type=implementation',
    ]);
    expect(result.status).toBe(0);

    const delegated = readBacklog().epics[0].tasks[0];
    expect(delegated.owner).toBe('worker-01');

    // Mark worker busy, then delegate again without target.
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({
      version: '1',
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-2',
        agent_id: 'worker-01',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }],
    }));
    const backlog = readBacklog();
    backlog.epics[0].tasks.push({ ref: 'docs/task-2', title: 'Task 2', status: 'todo', planning_state: 'ready_for_dispatch' });
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [
        { agent_id: 'worker-01', provider: 'codex', role: 'worker', status: 'running', session_handle: 'openai:session-worker-01', registered_at: new Date().toISOString() },
        { agent_id: 'reviewer-01', provider: 'claude', role: 'reviewer', capabilities: ['refactor'], status: 'offline', session_handle: null, registered_at: new Date().toISOString() },
      ],
    }));

    const second = runCli([
      '--task-ref=docs/task-2',
      '--task-type=implementation',
    ]);
    expect(second.status).toBe(0);
    const event = readEvents().at(-1);
    expect(event.event).toBe('task_delegated');
    expect(event.agent_id).toBeUndefined();
    expect(event.payload.target_agent_id).toBeNull();
  });

  it('clears stale owner when no eligible auto-target is found', () => {
    const backlog = readBacklog();
    backlog.epics[0].tasks.push({
      ref: 'docs/task-stale-owner',
      title: 'Stale owner task',
      status: 'todo',
      planning_state: 'ready_for_dispatch',
      owner: 'worker-01',
    });
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [
        { agent_id: 'worker-01', provider: 'codex', role: 'worker', status: 'running', session_handle: 'openai:session-worker-01', registered_at: new Date().toISOString() },
      ],
    }));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({
      version: '1',
      claims: [{
        run_id: 'run-busy-1',
        task_ref: 'docs/task-1',
        agent_id: 'worker-01',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }],
    }));

    const result = runCli([
      '--task-ref=docs/task-stale-owner',
      '--task-type=implementation',
    ]);
    expect(result.status).toBe(0);

    const task = readBacklog().epics[0].tasks.find((entry) => entry.ref === 'docs/task-stale-owner');
    expect(task.owner).toBeUndefined();
  });
});

function runCli(args) {
  return spawnSync('node', ['--experimental-strip-types', 'cli/delegate-task.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState() {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    epics: [{
      ref: 'docs',
      title: 'Docs',
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo', planning_state: 'ready_for_dispatch' }],
    }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [
      { agent_id: 'worker-01', provider: 'codex', role: 'worker', status: 'running', session_handle: 'openai:session-worker-01', registered_at: new Date().toISOString() },
      { agent_id: 'reviewer-01', provider: 'claude', role: 'reviewer', capabilities: ['refactor'], status: 'running', session_handle: 'claude:session-reviewer-01', registered_at: new Date().toISOString() },
    ],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function readBacklog() {
  return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
}

function readEvents() {
  const raw = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
