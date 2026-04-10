import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-backlog-blocked-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/backlog-blocked.ts', () => {
  it('shows no blocked tasks when none exist', () => {
    seedState([{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }]);
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Blocked Tasks (0)');
    expect(result.stdout).toContain('(none)');
  });

  it('lists blocked tasks with reason', () => {
    seedState([
      { ref: 'docs/task-1', title: 'Task 1', status: 'blocked', blocked_reason: 'waiting for external service' },
      { ref: 'docs/task-2', title: 'Task 2', status: 'todo' },
    ]);
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Blocked Tasks (1)');
    expect(result.stdout).toContain('docs/task-1');
    expect(result.stdout).toContain('waiting for external service');
  });

  it('outputs json with --json flag', () => {
    seedState([{ ref: 'docs/task-1', title: 'Task 1', status: 'blocked', blocked_reason: 'dependency missing' }]);
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBe(1);
    expect(json[0].ref).toBe('docs/task-1');
    expect(json[0].blocked_reason).toBe('dependency missing');
  });

  it('shows (no reason) when blocked_reason is not set', () => {
    seedState([{ ref: 'docs/task-1', title: 'Task 1', status: 'blocked' }]);
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('(no reason)');
  });

  it('returns empty json array when no blocked tasks', () => {
    seedState([]);
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toEqual([]);
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/backlog-blocked.ts', ...args], {
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
