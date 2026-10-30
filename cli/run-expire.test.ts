import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks, readClaims, readBacklog } from '../test-fixtures/stateHelpers.ts';
import { queryEvents } from '../lib/eventLog.ts';
import { runProjectCli } from '../test-fixtures/projectCli.ts';

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

    const claims = readClaims(dir);
    const claim = claims.find((c: Record<string, unknown>) => c.run_id === 'run-1');
    expect(claim?.state).toBe('failed');
    expect(claim?.failure_reason).toBe('manual_expire');

    const backlog = readBacklog(dir);
    const task = backlog.features[0].tasks.find((t: Record<string, unknown>) => t.ref === 'docs/task-1');
    expect(task?.status).toBe('todo');
  });

  it('clears finalization state on the expired claim', () => {
    const claimsState = JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8')) as { claims: Array<Record<string, unknown>> };
    Object.assign(claimsState.claims[0], {
      finalization_state: 'blocked_finalize',
      finalization_retry_count: 2,
      finalization_blocked_reason: 'branch is not rebased onto latest main',
    });
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(claimsState));

    expect(runCli(['run-1']).status).toBe(0);

    const claim = readClaims(dir).find((c: Record<string, unknown>) => c.run_id === 'run-1');
    expect(claim?.finalization_state).toBeNull();
    expect(claim?.finalization_retry_count).toBe(0);
    expect(claim?.finalization_blocked_reason).toBeNull();
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
  return runProjectCli(dir, 'cli/run-expire.ts', args);
}

function seedState() {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: 'worker-1', provider: 'claude', role: 'worker', status: 'running', session_handle: 'claude:session-1', registered_at: '2026-01-01T00:00:00Z' }],
  }));
  const claims = [{
    run_id: 'run-1',
    task_ref: 'docs/task-1',
    agent_id: 'worker-1',
    state: 'in_progress',
    claimed_at: '2026-01-01T00:00:00Z',
    started_at: '2026-01-01T00:01:00Z',
    lease_expires_at: '2099-01-01T00:00:00Z',
  }];
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  seedProjectTasks(dir, [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }], claims);
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
