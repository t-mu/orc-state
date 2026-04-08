import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { queryEvents } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-run-work-complete-test-');
  seedState();
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/run-work-complete.ts', () => {
  it('emits work_complete event when task is marked done', () => {
    const result = runCli(['--run-id=run-1', '--agent-id=worker-1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('work_complete: run-1 (worker-1)');
    const events = readEvents();
    const event = events.find((e) => e.event === 'work_complete' && e.run_id === 'run-1');
    expect(event).toBeDefined();
    expect(event?.agent_id).toBe('worker-1');
  });

  it('exits 1 when --run-id is missing', () => {
    const result = runCli(['--agent-id=worker-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-work-complete');
  });

  it('exits 1 when --agent-id is missing', () => {
    const result = runCli(['--run-id=run-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-work-complete');
  });

  it('exits 1 when task is not marked done', () => {
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
      version: '1',
      features: [{
        ref: 'docs',
        title: 'Docs',
        tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }],
      }],
    }));
    const result = runCli(['--run-id=run-1', '--agent-id=worker-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('task not marked done');
  });

  it('exits 1 when run-id does not exist in claims', () => {
    const result = runCli(['--run-id=run-missing', '--agent-id=worker-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/run-work-complete.ts', ...args], {
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
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'done' }],
    }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: 'worker-1', provider: 'claude', role: 'worker', status: 'running', session_handle: 'claude:session-1', registered_at: '2026-01-01T00:00:00Z' }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: [{
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-1',
      state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00Z',
      started_at: '2026-01-01T00:01:00Z',
      lease_expires_at: '2099-01-01T00:00:00Z',
    }],
  }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
