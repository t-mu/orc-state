import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, withEventDb, withEventDbTransaction } from './eventLog.ts';
import { bridgeInputRequest, bridgeInputResponse, bridgeReviewFeedback, readDurableInputResponse } from './messageBridge.ts';
import { consumeMessage, listMessages } from './messageRouter.ts';

let dir: string;
beforeEach(() => {
  dir = createTempStateDir('orch-message-bridge-');
  seedState(dir);
  initEventsDb(dir);
  withEventDbTransaction(dir, (db) => {
    db.prepare("INSERT INTO runs (run_id, task_ref, agent_id, state, created_at, updated_at) VALUES ('run-a', 'orch/a', 'worker-a', 'in_progress', 'now', 'now'), ('run-b', 'orch/b', 'worker-b', 'in_progress', 'now', 'now')").run();
    db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at)
      VALUES ('master-1', NULL, 'master', 'codex', 'running', 'now', 'now'),
        ('worker-a-1', 'run-a', 'worker-a', 'claude', 'running', 'now', 'now'),
        ('worker-b-1', 'run-b', 'worker-b', 'codex', 'running', 'now', 'now')`).run();
  });
});
afterEach(() => { closeAllDatabases(); cleanupTempStateDir(dir); });

describe('legacy input and review message bridge', () => {
  it('keeps late answers to an ended run on the legacy event path but rejects another agent', () => {
    bridgeInputRequest(dir, 'run-a', 'worker-a', 'request-1', 'Choose A?');
    withEventDbTransaction(dir, (db) => db.prepare("UPDATE runs SET state = 'failed' WHERE run_id = 'run-a'").run());
    expect(bridgeInputResponse(dir, 'run-a', 'worker-a', 'yes', null)).toBeNull();
    expect(() => bridgeInputResponse(dir, 'run-a', 'worker-b', 'yes', null)).toThrow('not scoped');
  });

  it('binds a human answer to one pending request and preserves it after reconnect', () => {
    const first = bridgeInputRequest(dir, 'run-a', 'worker-a', 'request-1', 'Choose A?');
    bridgeInputRequest(dir, 'run-b', 'worker-b', 'request-2', 'Choose B?');
    expect(first).toBeTruthy();
    expect(() => bridgeInputResponse(dir, 'run-a', 'worker-a', 'wrong request', 'request-2')).toThrow('not pending');
    expect(readDurableInputResponse(dir, 'request-1')).toBeNull();
    const answer = bridgeInputResponse(dir, 'run-a', 'worker-a', 'yes', 'request-1');
    expect(answer).toBeTruthy();
    expect(bridgeInputResponse(dir, 'run-a', 'worker-a', 'yes', 'request-1')).toBe(answer);
    expect(() => bridgeInputResponse(dir, 'run-a', 'worker-a', 'no', 'request-1')).toThrow('different response');
    expect(readDurableInputResponse(dir, 'request-1')).toBe('yes');
    expect(readDurableInputResponse(dir, 'request-2')).toBeNull();
    expect(withEventDb(dir, (db) => db.prepare('SELECT parent_message_id FROM messages WHERE message_id = ?').get(answer)))
      .toEqual({ parent_message_id: first });
    withEventDbTransaction(dir, (db) => {
      db.prepare("UPDATE sessions SET state = 'offline' WHERE session_id = 'worker-a-1'").run();
      db.prepare("INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at) VALUES ('worker-a-2', 'run-a', 'worker-a', 'claude', 'running', 'later', 'later')").run();
    });
    const principal = { agentId: 'worker-a', sessionId: 'worker-a-2' };
    expect(listMessages(dir, principal).map((message) => message.message_id)).toContain(answer);
    expect(consumeMessage(dir, principal, answer!).state).toBe('consumed');
    expect(listMessages(dir, principal).map((message) => message.message_id)).not.toContain(answer);
  });

  it('keeps legacy review feedback addressable as a durable message', () => {
    const id = bridgeReviewFeedback(dir, 'run-a', 'worker-a', 'findings', 'Fix line 3');
    expect(id).toBeTruthy();
    const mailbox = listMessages(dir, { agentId: 'worker-a', sessionId: 'worker-a-1' });
    expect(mailbox.find((message) => message.message_id === id)).toMatchObject({ kind: 'feedback', state: 'queued' });
    expect(JSON.parse(mailbox.find((message) => message.message_id === id)!.payload)).toEqual({ text: 'Fix line 3', outcome: 'findings' });
  });

  it('addresses the agent when its recipient has no running session', () => {
    withEventDbTransaction(dir, (db) => db.prepare("UPDATE sessions SET state = 'offline' WHERE session_id = 'master-1'").run());
    const id = bridgeInputRequest(dir, 'run-a', 'worker-a', 'request-2', 'Choose B?');
    expect(withEventDb(dir, (db) => db.prepare('SELECT recipient_id, recipient_session_id, recipient_agent_id FROM messages WHERE message_id = ?').get(id)))
      .toEqual({ recipient_id: 'master', recipient_session_id: null, recipient_agent_id: 'master' });
    const feedback = bridgeReviewFeedback(dir, 'run-a', 'worker-a', 'approved', 'ok');
    expect(withEventDb(dir, (db) => db.prepare('SELECT recipient_session_id, recipient_agent_id FROM messages WHERE message_id = ?').get(feedback)))
      .toEqual({ recipient_session_id: 'worker-a-1', recipient_agent_id: null });
  });
});
