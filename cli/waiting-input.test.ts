import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-waiting-input-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/waiting-input.ts', () => {
  it('shows no waiting runs when no claims have awaiting_input state', () => {
    seedState([{
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-1',
      state: 'in_progress',
      input_state: null,
      claimed_at: '2026-01-01T00:00:00Z',
      lease_expires_at: '2099-01-01T00:00:00Z',
    }]);
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Waiting for Input (0 runs)');
    expect(result.stdout).toContain('(none)');
  });

  it('shows runs with awaiting_input state', () => {
    seedState([{
      run_id: 'run-2',
      task_ref: 'docs/task-2',
      agent_id: 'worker-2',
      state: 'in_progress',
      input_state: 'awaiting_input',
      claimed_at: '2026-01-01T00:00:00Z',
      lease_expires_at: '2099-01-01T00:00:00Z',
    }]);
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Waiting for Input (1 runs)');
    expect(result.stdout).toContain('run-2');
    expect(result.stdout).toContain('worker-2');
  });

  it('outputs json with --json flag', () => {
    seedState([{
      run_id: 'run-3',
      task_ref: 'docs/task-3',
      agent_id: 'worker-3',
      state: 'in_progress',
      input_state: 'awaiting_input',
      claimed_at: '2026-01-01T00:00:00Z',
      lease_expires_at: '2099-01-01T00:00:00Z',
    }]);
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBe(1);
    expect(json[0].run_id).toBe('run-3');
    expect(json[0].agent_id).toBe('worker-3');
  });

  it('shows question text from input_requested event', () => {
    seedState([{
      run_id: 'run-4',
      task_ref: 'docs/task-4',
      agent_id: 'worker-4',
      state: 'in_progress',
      input_state: 'awaiting_input',
      claimed_at: '2026-01-01T00:00:00Z',
      lease_expires_at: '2099-01-01T00:00:00Z',
    }]);
    writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({
      seq: 1,
      ts: '2026-01-01T00:05:00Z',
      event: 'input_requested',
      actor_type: 'agent',
      actor_id: 'worker-4',
      run_id: 'run-4',
      task_ref: 'docs/task-4',
      agent_id: 'worker-4',
      payload: { question: 'what should I do?', request_id: 'req-xyz' },
    }) + '\n');
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('what should I do?');
  });

  it('returns empty json array when no runs are waiting', () => {
    seedState([]);
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toEqual([]);
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/waiting-input.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState(claims: unknown[]) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{
      ref: 'docs',
      title: 'Docs',
      tasks: [
        { ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' },
        { ref: 'docs/task-2', title: 'Task 2', status: 'in_progress' },
        { ref: 'docs/task-3', title: 'Task 3', status: 'in_progress' },
        { ref: 'docs/task-4', title: 'Task 4', status: 'in_progress' },
      ],
    }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}
