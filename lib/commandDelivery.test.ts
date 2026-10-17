import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, queryEvents, withEventDbTransaction } from './eventLog.ts';
import {
  CommandDispatcher, failTransport, getCommand,
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
});
