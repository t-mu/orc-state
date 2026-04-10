import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-backlog-ready-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/backlog-ready.ts', () => {
  it('shows no ready tasks when none have ready_for_dispatch planning state', () => {
    seedState([{ ref: 'docs/task-1', title: 'Task 1', status: 'todo', planning_state: 'draft' }]);
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dispatch-Ready Tasks (0)');
    expect(result.stdout).toContain('(none)');
  });

  it('lists dispatch-ready tasks', () => {
    seedState([
      { ref: 'docs/task-1', title: 'Task 1', status: 'todo', planning_state: 'ready_for_dispatch', priority: 'high' },
      { ref: 'docs/task-2', title: 'Task 2', status: 'todo', planning_state: 'draft' },
    ]);
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dispatch-Ready Tasks (1)');
    expect(result.stdout).toContain('docs/task-1');
    expect(result.stdout).not.toContain('docs/task-2');
  });

  it('does not list tasks with non-todo status even if ready_for_dispatch', () => {
    seedState([
      { ref: 'docs/task-1', title: 'Task 1', status: 'claimed', planning_state: 'ready_for_dispatch' },
    ]);
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('(none)');
  });

  it('outputs json with --json flag', () => {
    seedState([
      { ref: 'docs/task-1', title: 'Task 1', status: 'todo', planning_state: 'ready_for_dispatch', priority: 'normal' },
    ]);
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBe(1);
    expect(json[0].ref).toBe('docs/task-1');
  });

  it('returns empty json array when no ready tasks', () => {
    seedState([]);
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toEqual([]);
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/backlog-ready.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState(tasks: unknown[]) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'docs', title: 'Docs', tasks }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}
