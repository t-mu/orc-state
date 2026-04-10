import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-backlog-orient-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/backlog-orient.ts', () => {
  it('prints next_task_seq, backlog_docs_dir, and features list', () => {
    seedState();
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('next_task_seq:');
    expect(result.stdout).toContain('backlog_docs_dir:');
    expect(result.stdout).toContain('features (');
  });

  it('calculates next_task_seq from existing task refs', () => {
    seedState([{ ref: 'docs/42-my-task', title: 'My Task', status: 'todo' }]);
    const result = runCli([]);
    expect(result.status).toBe(0);
    // next_task_seq should be 43
    expect(result.stdout).toContain('next_task_seq: 43');
  });

  it('outputs json with --json flag', () => {
    seedState();
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(typeof json.next_task_seq).toBe('number');
    expect(typeof json.backlog_docs_dir).toBe('string');
    expect(Array.isArray(json.features)).toBe(true);
  });

  it('includes task counts per feature in json', () => {
    seedState([
      { ref: 'docs/1-task-a', title: 'Task A', status: 'todo' },
      { ref: 'docs/2-task-b', title: 'Task B', status: 'done' },
    ]);
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    const feature = json.features[0];
    expect(feature.task_counts.total).toBe(2);
    expect(feature.task_counts.todo).toBe(1);
    expect(feature.task_counts.done).toBe(1);
  });

  it('exits 1 when backlog state is not found', () => {
    // No backlog.json seeded
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('backlog state not found');
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/backlog-orient.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState(tasks: unknown[] = []) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'docs', title: 'Docs', tasks }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}
