import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, queryEvents, withEventDbTransaction } from './eventLog.ts';
import { commitClaims } from './runStore.ts';
import { ControlClient } from './controlClient.ts';
import { startControlServer, type ControlServer } from './controlServer.ts';
import { submitOperatorMutation } from './operatorDispatch.ts';
import { applyOperatorMutation, authorizeOperator, parseOperatorRequest } from './operatorMutations.ts';
import { readBacklog, readClaims } from './stateReader.ts';
import { invokeTool } from '../mcp/server.ts';
import { credentialHash } from './sessionCredentials.ts';
import { PROJECT_DESCRIPTOR } from './projectRegistry.ts';
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
  const operator = { credential: null, operator: true };

  it('an operator states its intent and acts as human, or as a registered agent it names', () => {
    expect(authorizeOperator(dir, operator, reset)).toEqual({ actorId: 'human' });
    expect(authorizeOperator(dir, operator, { ...reset, actor_id: 'master' })).toEqual({ actorId: 'master' });
    expect(() => authorizeOperator(dir, operator, { ...reset, actor_id: 'ghost' })).toThrow(expect.objectContaining({ code: 'bad_request' }));
    // Without a session or operator intent nothing is applied.
    expect(() => authorizeOperator(dir, { credential: null, operator: false }, reset)).toThrow(expect.objectContaining({ code: 'unauthenticated' }));
    // Answering a worker needs the master, as it always has.
    expect(() => authorizeOperator(dir, operator, { op: 'respond-input', run_id: 'run-a', agent_id: 'worker-a', response: 'yes' }))
      .toThrow(expect.objectContaining({ code: 'forbidden' }));
  });

  it('a session must be the master\'s, and acts only as the master', () => {
    const as = (credential: string) => ({ credential, operator: false });
    expect(authorizeOperator(dir, as('session-master'), reset)).toEqual({ actorId: 'master' });
    expect(() => authorizeOperator(dir, as('session-master'), { ...reset, actor_id: 'worker-a' })).toThrow(expect.objectContaining({ code: 'forbidden' }));
    // A worker session is refused even when it also claims operator intent.
    expect(() => authorizeOperator(dir, { credential: 'session-a', operator: true }, reset)).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(() => authorizeOperator(dir, as('forged'), reset)).toThrow(expect.objectContaining({ code: 'unauthenticated' }));
    // A master session the coordinator could not adopt after a restart still authenticates.
    withEventDbTransaction(dir, (db) => db.prepare("UPDATE sessions SET state = 'recoverable' WHERE session_id = 'session-master'").run());
    expect(authorizeOperator(dir, as('session-master'), reset)).toEqual({ actorId: 'master' });
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

    const master = new ControlClient(dir, { credential: 'session-master' });
    await expect(master.operator({ op: 'reset-task', task_ref: 'orch/active' })).resolves.toMatchObject({ reset: true });
    expect(queryEvents(dir, { event_type: 'run_cancelled' })).toEqual([expect.objectContaining({ actor_id: 'master' })]);

    // A worker session is neither; failures carry the CLI's text with a status.
    await expect(new ControlClient(dir, { credential: 'session-a' }).operator({ op: 'cancel-task', task_ref: 'orch/todo' }))
      .rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(operator.operator({ op: 'reset-task', task_ref: 'orch/missing' })).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(operator.operator({ op: 'unblock-task', task_ref: 'orch/todo' })).rejects.toMatchObject({ code: 'conflict', status: 409 });
    expect(status('orch/todo')).toBe('todo');

    // The operator is proven by the coordinator's operator token (task 231), not by claiming the role.
    rmSync(join(dir, 'operator.token'));
    await expect(operator.operator({ op: 'unblock-task', task_ref: 'orch/blocked' })).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
  });

  it('a shell inside a worker session presents it and is refused; only the master answers input', async () => {
    const workerEnv = { ORC_SESSION_SECRET: 'session-a' };
    await expect(submitOperatorMutation({ op: 'reset-task', task_ref: 'orch/todo' }, { env: workerEnv, project: 'p', stateDir: dir }))
      .rejects.toMatchObject({ code: 'forbidden' });
    const answer = { op: 'respond-input', run_id: 'run-a', agent_id: 'worker-a', response: 'go ahead' } as const;
    await expect(submitOperatorMutation(answer, { env: {}, project: 'p', stateDir: dir })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(submitOperatorMutation(answer, { env: { ORC_MASTER_SECRET: 'session-master' }, project: 'p', stateDir: dir }))
      .resolves.toMatchObject({ ok: true, responded_by: 'master' });
    expect(queryEvents(dir, { event_type: 'input_response' })).toEqual([expect.objectContaining({ actor_id: 'master', payload: expect.objectContaining({ response: 'go ahead' }) })]);
  });

  it('a CLI run with the master session in its environment acts as the master', async () => {
    await expect(submitOperatorMutation({ op: 'unblock-task', task_ref: 'orch/blocked' }, { env: { ORC_MASTER_SECRET: 'session-master' }, project: 'p', stateDir: dir }))
      .resolves.toMatchObject({ unblocked: true });
    expect(queryEvents(dir, { event_type: 'task_updated' }).at(-1)).toMatchObject({ actor_id: 'master' });
  });

  it('the master MCP tools act as the master, and respond_input needs its session', async () => {
    // A master tool's actor_id is ignored in a project: the master acts as itself.
    await expect(invokeTool(dir, 'reset_task', { task_ref: 'orch/todo', actor_id: 'human' }, { project: 'p', credential: 'session-master' }))
      .resolves.toMatchObject({ reset: true });
    expect(queryEvents(dir, { event_type: 'task_updated' }).at(-1)).toMatchObject({ actor_id: 'master' });
    expect(() => invokeTool(dir, 'respond_input', { run_id: 'run-a', agent_id: 'worker-a', response: 'yes' }, { project: 'p', credential: null }))
      .toThrow('respond_input needs the master session');
  });

  it('an MCP server inside a worker session presents it and is refused, not promoted to the operator', async () => {
    const before = status('orch/todo');
    await expect(invokeTool(dir, 'cancel_task', { task_ref: 'orch/todo' }, { project: 'p', credential: 'session-a' }))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(invokeTool(dir, 'reset_task', { task_ref: 'orch/todo' }, { project: 'p', credential: 'session-a' }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(status('orch/todo')).toBe(before);
    expect(() => invokeTool(dir, 'request_scout', { objective: 'look around' }, { project: 'p', credential: 'session-a' }))
      .toThrow(expect.objectContaining({ code: 'forbidden' }));
  });

  it('the master MCP tools are routed to the coordinator in a project', async () => {
    const result = await invokeTool(dir, 'cancel_task', { task_ref: 'orch/todo', reason: 'dropped' }, { project: 'p', credential: 'session-master' });
    expect(result).toMatchObject({ cancelled: true, status: 'blocked' });
    expect(queryEvents(dir, { event_type: 'task_cancelled' }).at(-1)).toMatchObject({ actor_id: 'master' });
  });
});

describe('operator mutations in a project state directory (task 231)', () => {
  beforeEach(() => {
    // A project descriptor marks the state directory as a project's: secrets only.
    writeFileSync(join(dir, PROJECT_DESCRIPTOR), JSON.stringify({ id: 'p1', name: 'demo', target_repo_root: dir }));
    withEventDbTransaction(dir, (db) => {
      db.prepare('UPDATE sessions SET credential_hash = ? WHERE session_id = ?').run(credentialHash('secret-master'), 'session-master');
      db.prepare('UPDATE sessions SET credential_hash = ? WHERE session_id = ?').run(credentialHash('secret-a'), 'session-a');
    });
  });

  it('authenticates the master by its secret, never by its recorded session id', async () => {
    const reset = { op: 'reset-task', task_ref: 'orch/active' } as const;
    expect(authorizeOperator(dir, { credential: 'secret-master', operator: false }, reset)).toEqual({ actorId: 'master' });
    expect(() => authorizeOperator(dir, { credential: 'session-master', operator: false }, reset)).toThrow(expect.objectContaining({ code: 'unauthenticated' }));
    expect(() => authorizeOperator(dir, { credential: 'secret-a', operator: false }, reset)).toThrow(expect.objectContaining({ code: 'forbidden' }));
    // The direct path applies the same rule with the coordinator down.
    const offline = { project: 'p', stateDir: dir, warn: vi.fn() };
    await expect(submitOperatorMutation(reset, { ...offline, env: { ORC_MASTER_SECRET: 'session-master' } })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(submitOperatorMutation(reset, { ...offline, env: { ORC_MASTER_SECRET: 'secret-master' } })).resolves.toMatchObject({ reset: true });
  });
});

describe('submitOperatorMutation without a coordinator (task 232)', () => {
  it('applies the coordinator\'s rule on the direct path too', async () => {
    const offline = { project: 'p', stateDir: dir, warn: vi.fn() };
    // A shell inside a worker session cannot use the direct path to act as the operator.
    await expect(submitOperatorMutation({ op: 'unblock-task', task_ref: 'orch/blocked' }, { ...offline, env: { ORC_SESSION_SECRET: 'session-a' } }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(status('orch/blocked')).toBe('blocked');
    // The master's session is recorded as the master.
    await submitOperatorMutation({ op: 'unblock-task', task_ref: 'orch/blocked' }, { ...offline, env: { ORC_MASTER_SECRET: 'session-master' } });
    expect(queryEvents(dir, { event_type: 'task_updated' }).at(-1)).toMatchObject({ actor_id: 'master' });
  });


  it('applies the mutation directly and says so', async () => {
    const warn = vi.fn();
    await expect(submitOperatorMutation({ op: 'unblock-task', task_ref: 'orch/blocked' }, { env: {}, project: 'p', stateDir: dir, warn }))
      .resolves.toEqual({ unblocked: true, task_ref: 'orch/blocked' });
    expect(warn).toHaveBeenCalledWith('coordinator is not running; applying unblock-task directly');
    expect(status('orch/blocked')).toBe('todo');
  });

  it('leaves the write to a live coordinator whose control API is not answering', async () => {
    writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    const warn = vi.fn();
    await expect(submitOperatorMutation({ op: 'unblock-task', task_ref: 'orch/blocked' }, { env: {}, project: 'p', stateDir: dir, warn }))
      .rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining(`coordinator (pid ${process.pid}) is running`) });
    expect(warn).not.toHaveBeenCalled();
    expect(status('orch/blocked')).toBe('blocked');
    // A lock whose PID now belongs to another process (a reused PID) holds nothing.
    writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), process_start: 'proc:0' }));
    await submitOperatorMutation({ op: 'unblock-task', task_ref: 'orch/blocked' }, { env: {}, project: 'p', stateDir: dir, warn });
    expect(warn).toHaveBeenCalledWith('coordinator is not running; applying unblock-task directly');
    expect(status('orch/blocked')).toBe('todo');
  });

  it('applies a legacy installation\'s mutation directly without a warning', async () => {
    const warn = vi.fn();
    await submitOperatorMutation({ op: 'unblock-task', task_ref: 'orch/blocked' }, { project: null, stateDir: dir, warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
