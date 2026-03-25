import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { queryEvents } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-task-mark-done-test-'));
  mkdirSync(join(dir, 'backlog'), { recursive: true });
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{
      ref: 'docs',
      title: 'Docs',
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }],
    }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli/task-mark-done.ts', () => {
  it('syncs a markdown-done task into runtime state and emits task_updated', () => {
    writeSpec('docs/task-1', 'docs', 'Task 1', 'done');
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(0);

    const task = readBacklog().features[0].tasks.find((entry) => entry.ref === 'docs/task-1');
    expect(task?.status).toBe('done');

    const event = readEvents().find((entry) => entry.event === 'task_updated' && entry.task_ref === 'docs/task-1');
    expect(event).toBeTruthy();
    expect(event?.payload).toMatchObject({ status: 'done', previous_status: 'todo' });
  });

  it('fails when markdown has not been updated to done yet', () => {
    writeSpec('docs/task-1', 'docs', 'Task 1', 'todo');
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be status: done');
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['--experimental-strip-types', 'cli/task-mark-done.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir, ORC_REPO_ROOT: dir },
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

function readBacklog(): { features: Array<{ tasks: Array<Record<string, unknown>> }> } {
  return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
