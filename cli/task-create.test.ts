import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { queryEvents } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-task-create-test-'));
  seedState();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli/task-create.ts', () => {
  it('creates task with todo + ready_for_dispatch', () => {
    writeSpec('docs/my-task', 'docs', 'My Task');
    const result = runCli([
      '--feature=docs',
      '--ref=my-task',
      '--title=My Task',
      '--task-type=implementation',
    ]);
    expect(result.status).toBe(0);
    const task = readBacklog().features[0].tasks.find((t) => t.ref === 'docs/my-task');
    expect(task).toBeTruthy();
    expect(task!.status).toBe('todo');
    expect(task!.planning_state).toBe('ready_for_dispatch');
  });

  it('rejects markdown-authoritative fields during generic task registration', () => {
    writeSpec('docs/ac-task', 'docs', 'AC Task');
    const result = runCli([
      '--feature=docs',
      '--ref=ac-task',
      '--title=AC Task',
      '--ac=first',
      '--depends-on=docs/task-1',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('create_task cannot set markdown-authoritative field(s)');
  });

  it('generates slug from title when --ref is omitted', () => {
    writeSpec('docs/hello-world-task', 'docs', 'Hello World! Task');
    const result = runCli([
      '--feature=docs',
      '--title=Hello World! Task',
    ]);
    expect(result.status).toBe(0);
    const task = readBacklog().features[0].tasks.find((t) => t.ref === 'docs/hello-world-task');
    expect(task).toBeTruthy();
  });

  it('syncs the feature from markdown when runtime backlog is stale', () => {
    writeSpec('missing/bad', 'missing', 'Bad');
    const result = runCli([
      '--feature=missing',
      '--title=Bad',
    ]);
    expect(result.status).toBe(0);
    const task = readBacklog().features.flatMap((feature) => feature.tasks).find((entry) => entry.ref === 'missing/bad');
    expect(task).toBeTruthy();
  });

  it('fails when task ref already exists', () => {
    writeSpec('docs/task-1', 'docs', 'Duplicate');
    const result = runCli([
      '--feature=docs',
      '--ref=task-1',
      '--title=Duplicate',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Task already exists');
  });

  it('fails when actor-id is invalid format', () => {
    writeSpec('docs/task', 'docs', 'Task');
    const result = runCli(['--feature=docs', '--title=Task', '--actor-id=INVALID']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid actor-id');
  });

  it('fails when title produces empty slug and no --ref given', () => {
    const result = runCli(['--feature=docs', '--title=!!!']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('slug is empty');
  });

  it('fails when owner value is invalid format', () => {
    writeSpec('docs/t', 'docs', 'T');
    const result = runCli(['--feature=docs', '--ref=t', '--title=T', '--owner=INVALID_CAPS']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid owner');
  });

  it('emits task_added event', () => {
    writeSpec('docs/event-task', 'docs', 'Event Task');
    const result = runCli([
      '--feature=docs',
      '--ref=event-task',
      '--title=Event Task',
      '--task-type=refactor',
      '--actor-id=master-01',
    ]);
    expect(result.status).toBe(0);
    const ev = readEvents().find((e) => e.event === 'task_added' && e.task_ref === 'docs/event-task');
    expect(ev).toBeTruthy();
    expect(ev.actor_type).toBe('agent');
    expect(ev.actor_id).toBe('master-01');
  });
  it('fails when no authoritative markdown spec exists for the task ref', () => {
    const result = runCli([
      '--feature=docs',
      '--ref=missing-spec',
      '--title=Missing Spec',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Task spec not found in backlog/');
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['--experimental-strip-types', 'cli/task-create.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir, ORC_REPO_ROOT: dir },
    encoding: 'utf8',
  });
}

function seedState() {
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
}

function writeSpec(taskRef: string, feature: string, title: string) {
  const slug = taskRef.split('/')[1];
  writeFileSync(
    join(dir, 'backlog', `999-${slug}.md`),
    [
      '---',
      `ref: ${taskRef}`,
      `feature: ${feature}`,
      'status: todo',
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
