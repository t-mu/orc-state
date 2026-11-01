import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reconcileState } from './reconcile.ts';
import { queryEvents } from './eventLog.ts';
import { detectLifecycleIssues } from './lifecycleDiagnostics.ts';
import { createTempStateDir, cleanupTempStateDir, seedState, seedProjectTasks, readStateFile, readBacklog } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-reconcile-test-');
  seedState(dir);
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

function writeState({ tasks, claims }: { tasks: Array<{ ref: string; title: string; status: string }>; claims: unknown[] }) {
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  seedProjectTasks(dir, tasks, claims);
}

describe('reconcileState', () => {
  it('is a no-op when state is consistent', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'a1',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T01:00:00.000Z',
      }],
    });

    reconcileState(dir);
    const backlog = readBacklog(dir);
    const claims = readStateFile<{ claims: Array<{ state: string }> }>(dir, 'claims.json');
    expect(backlog.features[0].tasks[0].status).toBe('claimed');
    expect(claims.claims[0].state).toBe('claimed');
  });

  it('repairs task status when active claim is in_progress', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'a1',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T01:00:00.000Z',
      }],
    });

    reconcileState(dir);
    const backlog = readBacklog(dir);
    expect(backlog.features[0].tasks[0].status).toBe('in_progress');
  });

  it('resets task to todo when task is active but claim is terminal', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'a1',
        state: 'done',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T01:00:00.000Z',
      }],
    });

    reconcileState(dir);
    const backlog = readBacklog(dir);
    expect(backlog.features[0].tasks[0].status).toBe('todo');
  });

  it('resets task to todo when no active claim exists', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }],
      claims: [],
    });

    reconcileState(dir);
    const backlog = readBacklog(dir);
    expect(backlog.features[0].tasks[0].status).toBe('todo');
  });

  it('marks orphan active claim as failed', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }],
      claims: [{
        run_id: 'run-orphan',
        task_ref: 'docs/missing-task',
        agent_id: 'a1',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T01:00:00.000Z',
      }],
    });

    reconcileState(dir);
    const claims = readStateFile<{ claims: Array<Record<string, unknown>> }>(dir, 'claims.json').claims;
    expect(claims[0]['state']).toBe('failed');
    expect(queryEvents(dir, { event_type: 'run_failed' })).toMatchObject([
      { run_id: 'run-orphan', payload: { reason: 'reconcile_orphan_claim' } },
    ]);
  });

  it('fails an active claim whose task row the project store does not reflect', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'a1',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T01:00:00.000Z',
      }],
    });

    reconcileState(dir);
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('todo');
    expect(readStateFile<{ claims: Array<{ state: string }> }>(dir, 'claims.json').claims[0].state).toBe('failed');
    expect(queryEvents(dir, { event_type: 'run_failed' })).toMatchObject([
      { run_id: 'run-1', payload: { reason: 'reconcile_status_mismatch' } },
    ]);
  });

  it('leaves a merged task and its unfinished run alone in the finalize window', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'done' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'a1',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T01:00:00.000Z',
      }],
    });

    reconcileState(dir);
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('done');
    expect(readStateFile<{ claims: Array<{ state: string }> }>(dir, 'claims.json').claims[0].state).toBe('in_progress');
    expect(queryEvents(dir, { event_type: 'run_failed' })).toEqual([]);
  });

  it.each(['failed', 'done'])('clears stale finalization fields on a %s claim without other changes', (state) => {
    const claim = {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'a1',
      state,
      claimed_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: '2026-01-01T01:00:00.000Z',
      finished_at: '2026-01-01T00:30:00.000Z',
    };
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }],
      claims: [{
        ...claim,
        finalization_state: 'blocked_finalize',
        finalization_retry_count: 2,
        finalization_blocked_reason: 'merge conflict',
      }],
    });
    expect(detectLifecycleIssues(dir).map((issue) => issue.code)).toContain('invalid_finalization_state');

    reconcileState(dir);

    expect(readStateFile<{ claims: unknown[] }>(dir, 'claims.json').claims).toEqual([{
      ...claim,
      finalization_state: null,
      finalization_retry_count: 0,
      finalization_blocked_reason: null,
    }]);
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('todo');
    expect(queryEvents(dir, {})).toEqual([]);
    expect(detectLifecycleIssues(dir)).toEqual([]);
  });

  it('is idempotent', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }],
      claims: [],
    });

    reconcileState(dir);
    const firstBacklog = readFileSync(join(dir, 'backlog.json'), 'utf8');
    const firstClaims = readFileSync(join(dir, 'claims.json'), 'utf8');
    reconcileState(dir);
    const secondBacklog = readFileSync(join(dir, 'backlog.json'), 'utf8');
    const secondClaims = readFileSync(join(dir, 'claims.json'), 'utf8');

    expect(secondBacklog).toBe(firstBacklog);
    expect(secondClaims).toBe(firstClaims);
  });
});
