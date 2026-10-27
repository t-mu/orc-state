import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, queryEvents, withEventDbTransaction } from './eventLog.ts';
import { commitClaims } from './runStore.ts';
import { ControlClient } from './controlClient.ts';
import { startControlServer, type ControlServer } from './controlServer.ts';
import { submitOperatorMutation } from './lifecycleDispatch.ts';
import { applyOperatorMutation, authorizeOperator, parseOperatorRequest } from './operatorMutations.ts';
import { readBacklog, readClaims } from './stateReader.ts';
import { invokeTool } from '../mcp/server.ts';
import type { Claim } from '../types/claims.ts';

let dir: string;

const task = (ref: string, status: string) => ({ ref, title: ref, status, task_type: 'implementation', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' });
const agent = (agent_id: string, role: string) => ({ agent_id, provider: 'claude', role, status: 'running', capabilities: [], registered_at: '2026-01-01T00:00:00.000Z' });

function claim(runId: string, taskRef: string): Claim {
  return {
    run_id: runId, task_ref: taskRef, agent_id: 'worker-a', state: 'in_progress',
    claimed_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:01.000Z', lease_expires_at: '2099-01-01T00:00:00.000Z',
  };
}

const status = (ref: string) => readBacklog(dir).features.flatMap((feature) => feature.tasks).find((entry) => entry.ref === ref)?.status;

beforeEach(() => {
  dir = createTempStateDir('orch-operator-');
  seedState(dir, {
    tasks: [task('orch/active', 'in_progress'), task('orch/blocked', 'blocked'), task('orch/todo', 'todo')],
    agents: [agent('master', 'master'), agent('worker-a', 'worker')],
  });
  initEventsDb(dir);
  commitClaims(dir, { version: '1', claims: [claim('run-a', 'orch/active')] });
  withEventDbTransaction(dir, (db) => {
    db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at)
      VALUES ('session-master', NULL, 'master', 'claude', 'running', '2026-01-01', '2026-01-01'),
        ('session-a', 'run-a', 'worker-a', 'claude', 'running', '2026-01-01', '2026-01-01')`).run();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

describe('parseOperatorRequest (task 232)', () => {
  it('accepts each op with its own fields and rejects anything else', () => {
    expect(parseOperatorRequest({ op: 'reset-task', task_ref: 'orch/active' })).toMatchObject({ op: 'reset-task' });
    expect(parseOperatorRequest({ op: 'respond-input', run_id: 'r', agent_id: 'a', response: 'yes', record_memory: true })).toMatchObject({ op: 'respond-input' });
    for (const body of [
      { op: 'drop-tables', task_ref: 'x' },
      { op: 'reset-task', task_ref: 'x', status: 'done' },
      { op: 'cancel-task', task_ref: 'x', actor_id: 'Not Valid' },
    ]) {
      expect(() => parseOperatorRequest(body), JSON.stringify(body)).toThrow(expect.objectContaining({ code: 'bad_request' }));
    }
  });
});

describe('authorizeOperator (task 232)', () => {
  const reset = { op: 'reset-task', task_ref: 'orch/active' } as const;

  it('an operator without a session acts as human, or as the actor it names', () => {
    expect(authorizeOperator(dir, null, reset)).toEqual({ actorId: 'human' });
    expect(authorizeOperator(dir, null, { ...reset, actor_id: 'ops-bot' })).toEqual({ actorId: 'ops-bot' });
  });

  it('a session must be the running master', () => {
    expect(authorizeOperator(dir, 'session-master', reset)).toEqual({ actorId: 'master' });
    expect(() => authorizeOperator(dir, 'session-a', reset)).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(() => authorizeOperator(dir, 'forged', reset)).toThrow(expect.objectContaining({ code: 'unauthenticated' }));
  });
});

describe('applyOperatorMutation (task 232)', () => {
  it('resets, unblocks, delegates and cancels as the CLI and the MCP tools did', () => {
    expect(applyOperatorMutation(dir, { op: 'reset-task', task_ref: 'orch/active', actor_id: 'human' }))
      .toMatchObject({ reset: true, previous_status: 'in_progress', cancelled_claims: 1 });
    expect(readClaims(dir).claims[0]).toMatchObject({ state: 'failed', failure_reason: 'manual_reset' });
    // The reset records the cancelled run, as the CLI always did.
    expect(queryEvents(dir, { event_type: 'run_cancelled' })).toEqual([expect.objectContaining({ run_id: 'run-a', actor_id: 'human' })]);

    expect(applyOperatorMutation(dir, { op: 'unblock-task', task_ref: 'orch/blocked', reason: 'fixed' })).toEqual({ unblocked: true, task_ref: 'orch/blocked' });
    expect(status('orch/blocked')).toBe('todo');
    expect(() => applyOperatorMutation(dir, { op: 'unblock-task', task_ref: 'orch/todo' })).toThrow('task is not blocked');

    expect(applyOperatorMutation(dir, { op: 'delegate-task', task_ref: 'orch/todo', actor_id: 'master' })).toMatchObject({ task_ref: 'orch/todo' });
    expect(applyOperatorMutation(dir, { op: 'cancel-task', task_ref: 'orch/todo', reason: 'dropped', actor_id: 'master' })).toMatchObject({ cancelled: true });
  });
});

describe('master and operator mutations through the coordinator (task 232)', () => {
  let server: ControlServer;

  beforeEach(async () => { server = await startControlServer(dir, { pollMs: 20 }); });
  afterEach(async () => { await server.close(); });

  it('the coordinator applies them, authorized as master or operator', async () => {
    const operator = new ControlClient(dir);
    await expect(operator.operator({ op: 'unblock-task', task_ref: 'orch/blocked' })).resolves.toEqual({ unblocked: true, task_ref: 'orch/blocked' });
    expect(queryEvents(dir, { event_type: 'task_updated' }).at(-1)).toMatchObject({ actor_id: 'human', task_ref: 'orch/blocked' });

    const master = new ControlClient(dir, { sessionToken: 'session-master' });
    await expect(master.operator({ op: 'reset-task', task_ref: 'orch/active' })).resolves.toMatchObject({ reset: true });
    expect(queryEvents(dir, { event_type: 'run_cancelled' })).toEqual([expect.objectContaining({ actor_id: 'master' })]);

    // A worker session is neither; failures carry the CLI's text with a status.
    await expect(new ControlClient(dir, { sessionToken: 'session-a' }).operator({ op: 'cancel-task', task_ref: 'orch/todo' }))
      .rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(operator.operator({ op: 'reset-task', task_ref: 'orch/missing' })).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(operator.operator({ op: 'unblock-task', task_ref: 'orch/todo' })).rejects.toMatchObject({ code: 'conflict', status: 409 });
    expect(status('orch/todo')).toBe('todo');
  });

  it('the master MCP tools are routed to the coordinator in a project', async () => {
    const result = await invokeTool(dir, 'cancel_task', { task_ref: 'orch/todo', reason: 'dropped' }, { project: 'p', masterSession: 'session-master' });
    expect(result).toMatchObject({ cancelled: true, status: 'blocked' });
    expect(queryEvents(dir, { event_type: 'task_cancelled' }).at(-1)).toMatchObject({ actor_id: 'master' });
  });
});

describe('submitOperatorMutation without a coordinator (task 232)', () => {
  it('applies the mutation directly and says so', async () => {
    const warn = vi.fn();
    await expect(submitOperatorMutation({ op: 'unblock-task', task_ref: 'orch/blocked' }, { project: 'p', stateDir: dir, warn }))
      .resolves.toEqual({ unblocked: true, task_ref: 'orch/blocked' });
    expect(warn).toHaveBeenCalledWith('coordinator is not running; applying unblock-task directly');
    expect(status('orch/blocked')).toBe('todo');
  });

  it('applies a legacy installation\'s mutation directly without a warning', async () => {
    const warn = vi.fn();
    await submitOperatorMutation({ op: 'unblock-task', task_ref: 'orch/blocked' }, { project: null, stateDir: dir, warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
