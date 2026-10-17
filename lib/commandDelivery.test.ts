import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, queryEvents, withEventDbTransaction } from './eventLog.ts';
import {
  CommandDispatcher, acknowledgeCommand, enqueueCommand, failTransport, getCommand,
  markSendStarted, markSent, reconcileCommands, reserveCommand, resolveUnknownCommand,
} from './commandDelivery.ts';

let dir: string;
const runId = 'run-command';
const enqueue = (key = 'key-1', extra = {}) => enqueueCommand(dir, {
  runId, actorSessionId: 'session-master', recipientSessionId: 'session-worker',
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
});
afterEach(() => { closeAllDatabases(); cleanupTempStateDir(dir); vi.restoreAllMocks(); });

describe('durable command delivery', () => {
  it('deduplicates by run and key, rejects changed content and wrong sessions', () => {
    const first = enqueue();
    expect(enqueue().command_id).toBe(first.command_id);
    expect(() => enqueue('key-1', { payload: { text: 'different' } })).toThrow('conflicts');
    expect(() => enqueue('other', { actorSessionId: 'session-worker', recipientSessionId: 'session-master' })).toThrow('Recipient');
    expect(queryEvents(dir, { event_type: 'command_queued' })).toHaveLength(1);
  });

  it('records transport delivery without semantic acceptance', async () => {
    const command = enqueue();
    const send = vi.fn().mockResolvedValue(undefined);
    await new CommandDispatcher(dir, { send }).tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(getCommand(dir, command.command_id).state).toBe('sent');
    expect(getCommand(dir, command.command_id).acknowledged_at).toBeNull();
    expect(() => acknowledgeCommand(dir, command.command_id, 'session-master', 'accepted')).toThrow('ACK from wrong recipient');
    expect(acknowledgeCommand(dir, command.command_id, 'session-worker', 'accepted').state).toBe('accepted');
    expect(acknowledgeCommand(dir, command.command_id, 'session-worker', 'running').state).toBe('running');
    expect(acknowledgeCommand(dir, command.command_id, 'session-worker', 'completed').state).toBe('completed');
  });

  it('recovers a crash before send and does not replay after the send marker', () => {
    const safe = enqueue('safe');
    expect(reserveCommand(dir)?.command_id).toBe(safe.command_id);
    expect(reconcileCommands(dir, new Date(Date.now() + 40000).toISOString())).toMatchObject([{ state: 'queued' }]);
    expect(reserveCommand(dir, new Date(Date.now() + 40000).toISOString())?.attempt_count).toBe(2);
    markSendStarted(dir, safe.command_id);
    expect(reconcileCommands(dir, new Date(Date.now() + 80000).toISOString())).toMatchObject([{ state: 'outcome_unknown' }]);
    expect(reserveCommand(dir)).toBeNull();
    expect(resolveUnknownCommand(dir, safe.command_id, 'session-master', 'failed', 'operator inspected output').state).toBe('failed');
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
    expect(acknowledgeCommand(dir, command.command_id, 'session-worker', 'accepted').state).toBe('accepted');
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
