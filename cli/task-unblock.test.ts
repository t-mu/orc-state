import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
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
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
      version: '1',
      features: [{
        ref: 'docs',
        title: 'Docs',
        tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }],
      }],
    }));
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not blocked');
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/task-unblock.ts', ...args], {
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
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'blocked', blocked_reason: 'awaiting external input' }],
    }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function readBacklog(): { features: Array<{ tasks: Array<Record<string, unknown>> }> } {
  return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')) as { features: Array<{ tasks: Array<Record<string, unknown>> }> };
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
