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
  it('reconciles a markdown-done spec with an active runtime task and emits task_updated', () => {
    writeSpec('docs/task-1', 'docs', 'Task 1', 'done');
    seedBacklogTask('in_progress');
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(0);

    const task = readBacklog().features[0].tasks.find((entry) => entry.ref === 'docs/task-1');
    expect(task?.status).toBe('done');

    const event = readEvents().find((entry) => entry.event === 'task_updated' && entry.task_ref === 'docs/task-1');
    expect(event).toBeTruthy();
    expect(event?.payload).toMatchObject({ status: 'done', previous_status: 'in_progress' });
  });

  it('auto-updates markdown spec from todo to done', () => {
    writeSpec('docs/task-1', 'docs', 'Task 1', 'todo');
    seedBacklogTask('in_progress');
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(0);

    // Verify the spec file was updated
    const specContent = readFileSync(join(dir, 'backlog', '999-task-1.md'), 'utf8');
    expect(specContent).toContain('status: done');
    expect(specContent).not.toContain('status: todo');

    // Verify backlog.json synced
    const task = readBacklog().features[0].tasks.find((entry) => entry.ref === 'docs/task-1');
    expect(task?.status).toBe('done');
  });

  it('is idempotent when spec is already done', () => {
    writeSpec('docs/task-1', 'docs', 'Task 1', 'done');
    seedBacklogTask('claimed');
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('task marked done');
  });

  it('is retryable when runtime state is already done', () => {
    writeSpec('docs/task-1', 'docs', 'Task 1', 'done');
    seedBacklogTask('done');

    const result = runCli(['docs/task-1']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('task marked done');
    const event = readEvents().find((entry) => entry.event === 'task_updated' && entry.task_ref === 'docs/task-1');
    expect(event?.payload).toMatchObject({ status: 'done', previous_status: 'done' });
  });

  it('fails when spec file is not found', () => {
    // No spec file written — only backlog.json has the task
    seedBacklogTask('in_progress');
    const result = runCli(['docs/task-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Task spec not found');
  });

  it('completes an in-progress runtime task even though generic sync would not overwrite it', () => {
    writeSpec('docs/task-1', 'docs', 'Task 1', 'todo');
    seedBacklogTask('in_progress');

    const result = runCli(['docs/task-1']);

    expect(result.status).toBe(0);
    const task = readBacklog().features[0].tasks.find((entry) => entry.ref === 'docs/task-1');
    expect(task?.status).toBe('done');
    expect(readFileSync(join(dir, 'backlog', '999-task-1.md'), 'utf8')).toContain('status: done');
  });

  it('rejects completion from todo', () => {
    writeSpec('docs/task-1', 'docs', 'Task 1', 'todo');
    seedBacklogTask('todo');

    const result = runCli(['docs/task-1']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be claimed or in_progress');
  });

  it('rejects completion from blocked', () => {
    writeSpec('docs/task-1', 'docs', 'Task 1', 'blocked');
    seedBacklogTask('blocked');

    const result = runCli(['docs/task-1']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be claimed or in_progress');
  });

  it('writes spec update to worktree backlog when cwd differs from repo root', () => {
    // Simulate a worktree: create a separate directory with its own backlog/
    const worktreeDir = mkdtempSync(join(tmpdir(), 'orc-worktree-'));
    mkdirSync(join(worktreeDir, 'backlog'), { recursive: true });
    // Write spec in the worktree backlog — spec frontmatter uses 'todo' (spec-level status),
    // while runtime backlog.json has 'in_progress' (runtime-level status).
    writeFileSync(
      join(worktreeDir, 'backlog', '999-task-1.md'),
      ['---', 'ref: docs/task-1', 'feature: docs', 'status: todo', '---', '', '# Task 1', ''].join('\n'),
    );
    // Also write spec in the main backlog (should NOT be touched)
    writeSpec('docs/task-1', 'docs', 'Task 1', 'todo');
    seedBacklogTask('in_progress');

    // Run from worktreeDir (simulates worker cwd)
    const result = runCli(['docs/task-1'], { cwd: worktreeDir });
    expect(result.status).toBe(0);

    // The worktree copy should be updated to done
    const worktreeSpec = readFileSync(join(worktreeDir, 'backlog', '999-task-1.md'), 'utf8');
    expect(worktreeSpec).toContain('status: done');

    // The main checkout copy should NOT have been modified
    const mainSpec = readFileSync(join(dir, 'backlog', '999-task-1.md'), 'utf8');
    expect(mainSpec).toContain('status: todo');

    rmSync(worktreeDir, { recursive: true, force: true });
  });
});

function runCli(args: string[], { cwd = dir }: { cwd?: string } = {}) {
  return spawnSync('node', ['--experimental-strip-types', join(repoRoot, 'cli/task-mark-done.ts'), ...args], {
    cwd,
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

function seedBacklogTask(status: string) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{
      ref: 'docs',
      title: 'Docs',
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status }],
    }],
  }));
}

function readBacklog(): { features: Array<{ tasks: Array<Record<string, unknown>> }> } {
  return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
