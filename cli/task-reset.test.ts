import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { queryEvents } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-task-reset-test-');
  seedState();
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/task-reset.ts', () => {
  it('resets an in_progress task back to todo', () => {
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('task reset: docs/task-1');
    const task = readBacklog().features[0].tasks.find((t: Record<string, unknown>) => t.ref === 'docs/task-1');
    expect(task?.status).toBe('todo');
  });

  it('cancels active claims for the reset task', () => {
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(0);
    const claims = readClaims();
    const claim = claims.find((c: Record<string, unknown>) => c.task_ref === 'docs/task-1');
    expect(claim?.state).toBe('failed');
    expect(claim?.failure_reason).toBe('manual_reset');
  });

  it('emits task_updated event with reset flag', () => {
    runCli(['docs/task-1']);
    const events = readEvents();
    const event = events.find((e) => e.event === 'task_updated' && e.task_ref === 'docs/task-1');
    expect(event).toBeDefined();
    expect((event?.payload as Record<string, unknown>)?.reset).toBe(true);
    expect((event?.payload as Record<string, unknown>)?.status).toBe('todo');
  });

  it('outputs cancelled claim count in message', () => {
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cancelled 1 active claims');
  });

  it('exits 1 when task-ref is not provided', () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc task-reset');
  });

  it('exits 1 when task is not found', () => {
    const result = runCli(['docs/nonexistent-task']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('task not found');
  });

  it('resets a blocked task with no active claims', () => {
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
      version: '1',
      features: [{
        ref: 'docs',
        title: 'Docs',
        tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'blocked', blocked_reason: 'stuck' }],
      }],
    }));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('task reset: docs/task-1');
    const task = readBacklog().features[0].tasks.find((t: Record<string, unknown>) => t.ref === 'docs/task-1');
    expect(task?.status).toBe('todo');
    expect(task?.blocked_reason).toBeUndefined();
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/task-reset.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState() {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{
      ref: 'docs',
      title: 'Docs',
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }],
    }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: 'worker-1', provider: 'claude', role: 'worker', status: 'running', session_handle: 'claude:session-1', registered_at: '2026-01-01T00:00:00Z' }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: [{
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-1',
      state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00Z',
      started_at: '2026-01-01T00:01:00Z',
      lease_expires_at: '2099-01-01T00:00:00Z',
    }],
  }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function readBacklog(): { features: Array<{ tasks: Array<Record<string, unknown>> }> } {
  return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')) as { features: Array<{ tasks: Array<Record<string, unknown>> }> };
}

function readClaims(): Array<Record<string, unknown>> {
  return (JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8')) as { claims: Array<Record<string, unknown>> }).claims;
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
