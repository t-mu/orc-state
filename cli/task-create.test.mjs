import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-task-create-test-'));
  seedState();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli/task-create.ts', () => {
  it('creates task with todo + ready_for_dispatch', () => {
    const result = runCli([
      '--epic=docs',
      '--ref=my-task',
      '--title=My Task',
      '--task-type=implementation',
    ]);
    expect(result.status).toBe(0);
    const task = readBacklog().epics[0].tasks.find((t) => t.ref === 'docs/my-task');
    expect(task).toBeTruthy();
    expect(task.status).toBe('todo');
    expect(task.planning_state).toBe('ready_for_dispatch');
  });

  it('populates acceptance_criteria from repeated --ac', () => {
    const result = runCli([
      '--epic=docs',
      '--ref=ac-task',
      '--title=AC Task',
      '--ac=first',
      '--ac=second',
    ]);
    expect(result.status).toBe(0);
    const task = readBacklog().epics[0].tasks.find((t) => t.ref === 'docs/ac-task');
    expect(task.acceptance_criteria).toEqual(['first', 'second']);
  });

  it('generates slug from title when --ref is omitted', () => {
    const result = runCli([
      '--epic=docs',
      '--title=Hello World! Task',
    ]);
    expect(result.status).toBe(0);
    const task = readBacklog().epics[0].tasks.find((t) => t.ref === 'docs/hello-world-task');
    expect(task).toBeTruthy();
  });

  it('fails when epic does not exist', () => {
    const result = runCli([
      '--epic=missing',
      '--title=Bad',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Epic not found');
  });

  it('fails when task ref already exists', () => {
    const result = runCli([
      '--epic=docs',
      '--ref=task-1',
      '--title=Duplicate',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Task already exists');
  });

  it('fails when actor-id is invalid format', () => {
    const result = runCli(['--epic=docs', '--title=Task', '--actor-id=INVALID']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid actor-id');
  });

  it('fails when title produces empty slug and no --ref given', () => {
    const result = runCli(['--epic=docs', '--title=!!!']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('slug is empty');
  });

  it('fails when owner value is invalid format', () => {
    const result = runCli(['--epic=docs', '--ref=t', '--title=T', '--owner=INVALID_CAPS']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid owner');
  });

  it('emits task_added event', () => {
    const result = runCli([
      '--epic=docs',
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
});

function runCli(args) {
  return spawnSync('node', ['--experimental-strip-types', 'cli/task-create.ts', ...args], {
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
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }],
    }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
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
