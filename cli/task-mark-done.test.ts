import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, readBacklog, seedState } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { queryEvents } from '../lib/eventLog.ts';
import { projectCliEnv } from '../test-fixtures/projectCli.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-task-mark-done-test-');
  mkdirSync(join(dir, 'backlog'), { recursive: true });
  writeSpec('docs/task-1', 'docs', 'Task 1', 'todo');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/task-mark-done.ts', () => {
  it('marks runtime state done and emits task_updated', () => {
    seedBacklogTask('in_progress');
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(0);

    const task = readBacklog(dir).features[0].tasks.find((entry) => entry.ref === 'docs/task-1');
    expect(task?.status).toBe('done');

    const event = readEvents().find((entry) => entry.event === 'task_updated' && entry.task_ref === 'docs/task-1');
    expect(event?.payload).toMatchObject({ status: 'done', previous_status: 'in_progress' });
  });

  it('does not modify markdown specs', () => {
    seedBacklogTask('in_progress');

    const before = readFileSync(join(dir, 'backlog', '999-task-1.md'), 'utf8');
    const result = runCli(['docs/task-1']);
    const after = readFileSync(join(dir, 'backlog', '999-task-1.md'), 'utf8');

    expect(result.status).toBe(0);
    expect(after).toBe(before);
    expect(after).toContain('status: todo');
  });

  it('is idempotent when runtime state is already done', () => {
    seedBacklogTask('done');

    const result = runCli(['docs/task-1']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('task marked done');
    const event = readEvents().find((entry) => entry.event === 'task_updated' && entry.task_ref === 'docs/task-1');
    expect(event?.payload).toMatchObject({ status: 'done', previous_status: 'done' });
  });

  it('does not require a task spec file', () => {
    seedBacklogTask('in_progress');
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(0);
  });

  it('refuses completion from todo: the project store records done only for a merged in_progress run', () => {
    seedBacklogTask('todo');

    const result = runCli(['docs/task-1']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid task transition');
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('todo');
  });

  it('rejects completion from blocked', () => {
    seedBacklogTask('blocked');

    const result = runCli(['docs/task-1']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot transition to done from status blocked');
  });

});

function runCli(args: string[], { cwd = dir }: { cwd?: string } = {}) {
  return spawnSync('node', [join(repoRoot, 'cli/task-mark-done.ts'), ...args], {
    cwd,
    env: projectCliEnv(dir),
    encoding: 'utf8',
  });
}

function writeSpec(taskRef: string, feature: string, title: string, status: string) {
  const slug = taskRef.split('/')[1];
  writeFileSync(
    join(dir, 'backlog', `999-${slug}.md`),
    [
      '---',
      `ref: ${taskRef}`,
      `feature: ${feature}`,
      `status: ${status}`,
      '---',
      '',
      `# Task 999 — ${title}`,
      '',
    ].join('\n'),
  );
}

function seedBacklogTask(status: string) {
  seedState(dir, { tasks: [{ ref: 'docs/task-1', title: 'Task 1', status }] });
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
