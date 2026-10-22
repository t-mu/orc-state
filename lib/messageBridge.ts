import { randomUUID } from 'node:crypto';
import { withEventDb, withEventDbTransaction } from './eventLog.ts';

type Run = { run_id: string; agent_id: string | null; state: string };
type Session = { session_id: string; agent_id: string; run_id: string | null };

function activeRun(db: import('better-sqlite3').Database, runId: string, agentId: string): Run | null {
  const run = db.prepare('SELECT run_id, agent_id, state FROM runs WHERE run_id = ?').get(runId) as Run | undefined;
  if (!run) return null;
  if (run.agent_id !== agentId || !['claimed', 'in_progress'].includes(run.state)) throw new Error('Message actor is not scoped to an active run');
  return run;
}

function runningSession(db: import('better-sqlite3').Database, agentId: string, runId: string | null): Session | null {
  return db.prepare("SELECT session_id, agent_id, run_id FROM sessions WHERE agent_id = ? AND run_id IS ? AND state = 'running' ORDER BY started_at DESC LIMIT 1")
    .get(agentId, runId) as Session | undefined ?? null;
}

/** Add a durable copy when the run has moved to the operational tables. */
export function bridgeInputRequest(stateDir: string, runId: string, agentId: string, requestId: string, question: string): string | null {
  return withEventDbTransaction(stateDir, (db) => {
    if (!activeRun(db, runId, agentId)) return null;
    const sender = runningSession(db, agentId, runId);
    const master = runningSession(db, 'master', null);
    const messageId = `msg-${randomUUID()}`;
    db.prepare(`INSERT OR IGNORE INTO messages
      (message_id, run_id, idempotency_key, direction, kind, payload, created_at, sender_id, sender_session_id,
       recipient_id, recipient_session_id, recipient_run_id)
      VALUES (?, ?, ?, 'outbound', 'question', ?, ?, ?, ?, 'master', ?, NULL)`)
      .run(messageId, runId, `input:${requestId}`, JSON.stringify({ text: question, request_id: requestId }),
        new Date().toISOString(), agentId, sender?.session_id ?? null, master?.session_id ?? null);
    const stored = db.prepare('SELECT message_id FROM messages WHERE idempotency_key = ?').get(`input:${requestId}`) as { message_id: string };
    db.prepare(`INSERT OR IGNORE INTO input_requests
      (request_id, run_id, message_id, idempotency_key, question, state, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(requestId, runId, stored.message_id, `input:${requestId}`, question, new Date().toISOString());
    return stored.message_id;
  });
}

/** Returns null for legacy event-only requests; otherwise binds response to one pending request. */
export function bridgeInputResponse(stateDir: string, runId: string, agentId: string, response: string, requestId?: string | null): string | null {
  return withEventDbTransaction(stateDir, (db) => {
    if (!activeRun(db, runId, agentId)) return null;
    const request = db.prepare(`SELECT request_id, message_id FROM input_requests WHERE run_id = ? AND state = 'pending'
      ${requestId ? 'AND request_id = ?' : ''} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(...(requestId ? [runId, requestId] : [runId])) as { request_id: string; message_id: string | null } | undefined;
    if (!request) {
      if (requestId && db.prepare('SELECT 1 FROM input_requests WHERE run_id = ?').get(runId)) throw new Error('Input request is not pending for this run');
      return null;
    }
    const recipient = runningSession(db, agentId, runId);
    const id = `msg-${randomUUID()}`;
    db.prepare(`INSERT INTO messages
      (message_id, run_id, idempotency_key, direction, kind, payload, created_at, sender_id,
       recipient_id, recipient_session_id, recipient_run_id, parent_message_id)
      VALUES (?, ?, ?, 'inbound', 'feedback', ?, ?, 'human', ?, ?, ?, ?)`)
      .run(id, runId, `input-response:${request.request_id}`, JSON.stringify({ text: response, request_id: request.request_id }),
        new Date().toISOString(), agentId, recipient?.session_id ?? null, runId, request.message_id);
    db.prepare("UPDATE input_requests SET state = 'answered', response = ?, answered_at = ? WHERE request_id = ?")
      .run(response, new Date().toISOString(), request.request_id);
    return id;
  });
}

export function readDurableInputResponse(stateDir: string, requestId: string): string | null {
  return withEventDb(stateDir, (db) => {
    const row = db.prepare("SELECT response FROM input_requests WHERE request_id = ? AND state = 'answered'").get(requestId) as { response: string | null } | undefined;
    return row?.response ?? null;
  });
}

export function bridgeReviewFeedback(stateDir: string, runId: string, agentId: string, outcome: 'approved' | 'findings', reason: string): string | null {
  return withEventDbTransaction(stateDir, (db) => {
    if (!activeRun(db, runId, agentId)) return null;
    const sender = runningSession(db, agentId, runId);
    const master = runningSession(db, 'master', null);
    const id = `msg-${randomUUID()}`;
    db.prepare(`INSERT INTO messages
      (message_id, run_id, idempotency_key, direction, kind, payload, created_at, sender_id, sender_session_id,
       recipient_id, recipient_session_id, recipient_run_id)
      VALUES (?, ?, ?, 'outbound', 'feedback', ?, ?, ?, ?, 'master', ?, NULL)`)
      .run(id, runId, `review:${id}`, JSON.stringify({ text: reason, outcome }), new Date().toISOString(),
        agentId, sender?.session_id ?? null, master?.session_id ?? null);
    return id;
  });
}
