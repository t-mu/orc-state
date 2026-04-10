import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { queryEvents } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-run-expire-test-');
  seedState();
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/run-expire.ts', () => {
  it('expires an in_progress claim and requeues the task', () => {
    const result = runCli(['run-1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run expired: run-1');
    expect(result.stdout).toContain('docs/task-1 requeued');

    const claims = readClaims();
    const claim = claims.find((c: Record<string, unknown>) => c.run_id === 'run-1');
    expect(claim?.state).toBe('failed');
    expect(claim?.failure_reason).toBe('manual_expire');

    const backlog = readBacklog();
    const task = backlog.features[0].tasks.find((t: Record<string, unknown>) => t.ref === 'docs/task-1');
    expect(task?.status).toBe('todo');
  });

  it('emits claim_expired event', () => {
    runCli(['run-1']);
    const events = readEvents();
    const event = events.find((e) => e.event === 'claim_expired' && e.run_id === 'run-1');
    expect(event).toBeDefined();
    expect((event?.payload as Record<string, unknown>)?.reason).toBe('manual_expire');
  });

  it('exits 1 when run-id is not provided', () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-expire');
  });

  it('exits 1 when run-id is not found', () => {
    const result = runCli(['run-missing']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run not found');
  });

  it('exits 1 when run is already in terminal state', () => {
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({
      version: '1',
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'worker-1',
        state: 'done',
        claimed_at: '2026-01-01T00:00:00Z',
        finished_at: '2026-01-01T01:00:00Z',
      }],
    }));
    const result = runCli(['run-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already terminal');
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/run-expire.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState() {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{
      ref: 'docs',
      title: 'Docs',
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }],
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

function readClaims(): Array<Record<string, unknown>> {
  return (JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8')) as { claims: Array<Record<string, unknown>> }).claims;
}

function readBacklog() {
  return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')) as { features: Array<{ tasks: Array<Record<string, unknown>> }> };
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
