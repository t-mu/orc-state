import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, readBacklog as readProjectBacklog, seedState as seedProjectState } from '../test-fixtures/stateHelpers.ts';
import { initProjectTaskStore } from '../lib/projectTasks.ts';
import { spawnSync } from 'node:child_process';
import { queryEvents } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-task-unblock-test-');
  seedState();
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/task-unblock.ts', () => {
  it('transitions a blocked task to todo', () => {
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('task unblocked: docs/task-1');
    const task = readBacklog().features[0].tasks.find((t: Record<string, unknown>) => t.ref === 'docs/task-1');
    expect(task?.status).toBe('todo');
    expect(task?.blocked_reason).toBeUndefined();
  });

  it('emits task_updated event with unblocked flag', () => {
    runCli(['docs/task-1']);
    const events = readEvents();
    const event = events.find((e) => e.event === 'task_updated' && e.task_ref === 'docs/task-1');
    expect(event).toBeDefined();
    expect((event?.payload as Record<string, unknown>)?.unblocked).toBe(true);
    expect((event?.payload as Record<string, unknown>)?.previous_status).toBe('blocked');
  });

  it('includes reason in event payload when --reason is provided', () => {
    runCli(['docs/task-1', '--reason=resolved by operator']);
    const events = readEvents();
    const event = events.find((e) => e.event === 'task_updated' && e.task_ref === 'docs/task-1');
    expect((event?.payload as Record<string, unknown>)?.reason).toBe('resolved by operator');
  });

  it('exits 1 when task-ref is not provided', () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc task-unblock');
  });

  it('exits 1 when task is not found', () => {
    const result = runCli(['docs/nonexistent-task']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('task not found');
  });

  it('exits 1 when task is not blocked', () => {
    initProjectTaskStore(dir).applyTransition('docs/task-1', { cause: 'unblock', to: 'todo', actorId: 'human' });
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not blocked');
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/task-unblock.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState() {
  seedProjectState(dir, {
    tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'blocked', blocked_reason: 'awaiting external input' }],
  });
}

function readBacklog() {
  return readProjectBacklog(dir);
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
