import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, queryEvents, withEventDbTransaction } from './eventLog.ts';
import {
  CommandDispatcher, acknowledgeFromRuntime, failTransport, getCommand,
  markSendStarted, markSent, reconcileCommands, reserveCommand,
} from './commandDelivery.ts';

let dir: string;
let queue: CommandDispatcher;
const runId = 'run-command';
const authenticate = (credential: string) => ({
  'master-secret': { agentId: 'master', sessionId: 'session-master' },
  'worker-secret': { agentId: 'worker-1', sessionId: 'session-worker' },
}[credential] ?? null);
const enqueue = (key = 'key-1', extra = {}) => queue.enqueue('master-secret', {
  runId, recipientSessionId: 'session-worker',
  idempotencyKey: key, kind: 'input', payload: { text: 'do work' }, ...extra,
});

beforeEach(() => {
  dir = createTempStateDir('orch-command-');
  seedState(dir);
  initEventsDb(dir);
  withEventDbTransaction(dir, (db) => {
    db.prepare(`INSERT INTO runs (run_id, task_ref, agent_id, state, created_at, updated_at)
      VALUES (?, 'orch/task-1', 'worker-1', 'in_progress', '2026-01-01', '2026-01-01')`).run(runId);
    db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at)
      VALUES ('session-master', NULL, 'master', 'codex', 'running', '2026-01-01', '2026-01-01'),
        ('session-worker', ?, 'worker-1', 'codex', 'running', '2026-01-01', '2026-01-01')`).run(runId);
  });
  queue = new CommandDispatcher(dir, { send: async () => {} }, authenticate);
});
afterEach(() => { closeAllDatabases(); cleanupTempStateDir(dir); vi.restoreAllMocks(); });

describe('durable command delivery', () => {
  it('deduplicates by run and key, rejects changed content and wrong sessions', () => {
    const first = enqueue();
    expect(enqueue().command_id).toBe(first.command_id);
    expect(() => enqueue('key-1', { payload: { text: 'different' } })).toThrow('conflicts');
    expect(() => enqueue('key-1', { sideEffecting: false })).toThrow('conflicts');
    expect(() => enqueue('key-1', { maxAttempts: 4 })).toThrow('conflicts');
    expect(() => enqueue('key-1', { deadlineAt: '2030-01-01T00:00:00Z' })).toThrow('conflicts');
    expect(() => enqueue('other', { recipientSessionId: 'session-master' })).toThrow('Recipient');
    expect(() => queue.enqueue('wrong-secret', { runId, recipientSessionId: 'session-worker', idempotencyKey: 'x', kind: 'input', payload: {} })).toThrow('not authenticated');
    expect(queryEvents(dir, { event_type: 'command_queued' })).toHaveLength(1);
  });

  it('records transport delivery without semantic acceptance', async () => {
    const command = enqueue();
    const send = vi.fn().mockResolvedValue(undefined);
    await new CommandDispatcher(dir, { send }, authenticate).tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(getCommand(dir, command.command_id).state).toBe('sent');
    expect(getCommand(dir, command.command_id).acknowledged_at).toBeNull();
    expect(() => queue.acknowledge('master-secret', command.command_id, 'accepted')).toThrow('ACK from wrong recipient');
    expect(queue.acknowledge('worker-secret', command.command_id, 'accepted').state).toBe('accepted');
    expect(queue.acknowledge('worker-secret', command.command_id, 'running').state).toBe('running');
    expect(queue.acknowledge('worker-secret', command.command_id, 'completed').state).toBe('completed');
  });

  it('recovers a crash before send and does not replay after the send marker', () => {
    const safe = enqueue('safe');
    expect(reserveCommand(dir)?.command_id).toBe(safe.command_id);
    expect(reconcileCommands(dir, new Date(Date.now() + 40000).toISOString())).toMatchObject([{ state: 'queued' }]);
    expect(reserveCommand(dir, new Date(Date.now() + 40000).toISOString())?.attempt_count).toBe(2);
    markSendStarted(dir, safe.command_id);
    expect(reconcileCommands(dir, new Date(Date.now() + 80000).toISOString())).toMatchObject([{ state: 'outcome_unknown' }]);
    expect(reserveCommand(dir)).toBeNull();
    expect(queue.resolveUnknown('master-secret', safe.command_id, 'failed', 'operator inspected output').state).toBe('failed');
  });

  it('survives a subprocess exit between the send marker and transport return', () => {
    const command = enqueue();
    reserveCommand(dir);
    closeAllDatabases();
    const script = `import { markSendStarted } from './lib/commandDelivery.ts'; markSendStarted(process.argv[1], process.argv[2]);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir, command.command_id], {
      cwd: join(import.meta.dirname, '..'), encoding: 'utf8',
    });
    expect(child.status, child.stderr).toBe(0);
    expect(reconcileCommands(dir, new Date(Date.now() + 40000).toISOString())[0].state).toBe('outcome_unknown');
  });

  it('marks transport failure uncertain and permits a late semantic ACK', () => {
    const command = enqueue();
    reserveCommand(dir);
    markSendStarted(dir, command.command_id);
    expect(failTransport(dir, command.command_id, 'connection reset').state).toBe('outcome_unknown');
    expect(queue.acknowledge('worker-secret', command.command_id, 'accepted').state).toBe('accepted');
  });

  it('accepts a late ACK after a sent command times out', () => {
    const command = enqueue('late', { deadlineAt: new Date(Date.now() + 1000).toISOString() });
    reserveCommand(dir);
    markSendStarted(dir, command.command_id);
    markSent(dir, command.command_id);
    expect(reconcileCommands(dir, new Date(Date.now() + 2000).toISOString())[0].state).toBe('outcome_unknown');
    expect(() => queue.resolveUnknown('worker-secret', command.command_id, 'failed', 'inspection')).toThrow('Master session required');
    expect(queue.acknowledge('worker-secret', command.command_id, 'accepted').state).toBe('accepted');
  });

  it('wakes dispatch on enqueue and bounds a stalled provider write', async () => {
    const send = vi.fn().mockImplementation(() => new Promise<void>(() => {}));
    const dispatcher = new CommandDispatcher(dir, { send }, authenticate, 5, 20);
    dispatcher.start();
    const command = dispatcher.enqueue('master-secret', {
      runId, recipientSessionId: 'session-worker',
      idempotencyKey: 'hung', kind: 'input', payload: { text: 'do work' },
    });
    await vi.waitFor(() => expect(getCommand(dir, command.command_id).state).toBe('outcome_unknown'));
    expect(send).toHaveBeenCalledTimes(1);
    dispatcher.stop();
  });

  it('fails queued commands when the run ends and prevents a reserved command from sending', () => {
    const command = enqueue();
    reserveCommand(dir);
    withEventDbTransaction(dir, (db) => db.prepare("UPDATE runs SET state = 'failed' WHERE run_id = ?").run(runId));
    expect(() => markSendStarted(dir, command.command_id)).toThrow('Run is no longer active');
    expect(reconcileCommands(dir)[0].state).toBe('failed');
  });

  it('bounds repeatable retries and makes timeout and provider exit explicit', () => {
    const repeatable = enqueue('retry', { sideEffecting: false, maxAttempts: 2 });
    reserveCommand(dir);
    markSendStarted(dir, repeatable.command_id);
    expect(failTransport(dir, repeatable.command_id, 'disconnect').state).toBe('queued');
    const next = new Date(Date.now() + 40000).toISOString();
    expect(reserveCommand(dir, next)?.attempt_count).toBe(2);
    markSendStarted(dir, repeatable.command_id);
    expect(failTransport(dir, repeatable.command_id, 'disconnect again').state).toBe('failed');

    const expired = enqueue('expired', { deadlineAt: new Date(Date.now() - 1000).toISOString() });
    expect(reconcileCommands(dir)[0].command_id).toBe(expired.command_id);
    expect(getCommand(dir, expired.command_id).state).toBe('failed');

    const exiting = enqueue('exit');
    reserveCommand(dir);
    markSendStarted(dir, exiting.command_id);
    markSent(dir, exiting.command_id);
    withEventDbTransaction(dir, (db) => db.prepare("UPDATE sessions SET state = 'offline' WHERE session_id = 'session-worker'").run());
    expect(reconcileCommands(dir)[0].state).toBe('outcome_unknown');
  });

  it('lets the in-process coordinator enqueue for a run without a session credential (task 203)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new CommandDispatcher(dir, { send }, authenticate);
    const command = dispatcher.enqueueFromCoordinator({ runId, recipientSessionId: 'session-worker', idempotencyKey: 'envelope', kind: 'task_envelope', payload: { text: 'TASK_START' } });
    expect(command).toMatchObject({ actor_id: 'coordinator', actor_session_id: null, recipient_id: 'worker-1', state: 'queued' });
    expect(dispatcher.enqueueFromCoordinator({ runId, recipientSessionId: 'session-worker', idempotencyKey: 'envelope', kind: 'task_envelope', payload: { text: 'TASK_START' } }).command_id).toBe(command.command_id);
    expect(() => dispatcher.enqueueFromCoordinator({ runId, recipientSessionId: 'session-master', idempotencyKey: 'other', kind: 'x', payload: {} })).toThrow('Recipient');

    expect(await dispatcher.deliver(command.command_id)).toMatchObject({ state: 'sent' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('applies protocol ACKs idempotently, in order, from the recipient session only (task 203)', () => {
    const command = enqueue();
    expect(() => acknowledgeFromRuntime(dir, command.command_id, 'session-worker', 'accepted')).toThrow('Cannot acknowledge queued');
    reserveCommand(dir);
    markSendStarted(dir, command.command_id);
    expect(() => acknowledgeFromRuntime(dir, command.command_id, 'session-master', 'running')).toThrow('wrong session');

    // turn/started can beat the turn/start answer: dispatching jumps through accepted to running.
    expect(acknowledgeFromRuntime(dir, command.command_id, 'session-worker', 'running').state).toBe('running');
    expect(acknowledgeFromRuntime(dir, command.command_id, 'session-worker', 'accepted').state).toBe('running');
    expect(markSent(dir, command.command_id).state).toBe('running');
    expect(acknowledgeFromRuntime(dir, command.command_id, 'session-worker', 'failed', 'provider turn failed')).toMatchObject({ state: 'failed', last_error: 'provider turn failed' });
    expect(acknowledgeFromRuntime(dir, command.command_id, 'session-worker', 'completed').state).toBe('failed');
    expect(queryEvents(dir, { event_type: 'command_accepted' })).toHaveLength(1);
    expect(queryEvents(dir, { event_type: 'command_running' })).toHaveLength(1);
    expect(queryEvents(dir, { event_type: 'command_failed' })).toHaveLength(1);
  });

  it('completes a protocol-ACKed command that jumped straight from sent to completed', () => {
    const command = enqueue();
    reserveCommand(dir);
    markSendStarted(dir, command.command_id);
    markSent(dir, command.command_id);
    expect(acknowledgeFromRuntime(dir, command.command_id, 'session-worker', 'completed')).toMatchObject({ state: 'completed', terminal_at: expect.any(String) });
    expect(queryEvents(dir, { event_type: 'command_accepted' })).toHaveLength(1);
  });

  it('holds a command for a busy recipient without spending an attempt or marking it sent (task 203)', async () => {
    let busy = true;
    const send = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new CommandDispatcher(dir, { send, isBusy: () => busy }, authenticate);
    const command = enqueue('busy', { maxAttempts: 1 });

    const held = await dispatcher.deliver(command.command_id);
    expect(held).toMatchObject({ state: 'queued', attempt_count: 0, send_started_at: null, last_error: 'recipient busy' });
    expect(send).not.toHaveBeenCalled();
    expect(reconcileCommands(dir)).toEqual([]);

    // The sweep retries it once the retry time passes and the recipient is free.
    busy = false;
    await vi.waitFor(async () => {
      await dispatcher.tick();
      expect(getCommand(dir, command.command_id)).toMatchObject({ state: 'sent', attempt_count: 1 });
    }, { timeout: 3000, interval: 100 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
