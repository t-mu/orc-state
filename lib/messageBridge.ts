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

/** Returns null for legacy event-only requests; otherwise binds response to one request. */
export function bridgeInputResponse(stateDir: string, runId: string, agentId: string, response: string, requestId?: string | null,
  authority: { sessionId?: string | null | undefined; trustedMaster?: boolean } = {}): string | null {
  return withEventDbTransaction(stateDir, (db) => {
    if (!activeRun(db, runId, agentId)) return null;
    const request = db.prepare(`SELECT request_id, message_id, state, response FROM input_requests WHERE run_id = ?
      ${requestId ? 'AND request_id = ?' : ''} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(...(requestId ? [runId, requestId] : [runId])) as { request_id: string; message_id: string | null; state: string; response: string | null } | undefined;
    if (!request) {
      if (requestId && db.prepare('SELECT 1 FROM input_requests WHERE run_id = ?').get(runId)) throw new Error('Input request is not pending for this run');
      return null;
    }
    if (!authority.trustedMaster) {
      const master = authority.sessionId ? runningSession(db, 'master', null) : null;
      if (!master || master.session_id !== authority.sessionId) throw new Error('Input response requires a running master session');
    }
    if (request.state === 'answered') {
      if (request.response !== response) throw new Error('Input request already has a different response');
      const existing = db.prepare('SELECT message_id FROM messages WHERE idempotency_key = ?')
        .get(`input-response:${request.request_id}`) as { message_id: string } | undefined;
      return existing?.message_id ?? null;
    }
    if (request.state !== 'pending') throw new Error('Input request is not pending for this run');
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
    const recipient = runningSession(db, agentId, runId);
    const id = `msg-${randomUUID()}`;
    db.prepare(`INSERT INTO messages
      (message_id, run_id, idempotency_key, direction, kind, payload, created_at, sender_id, sender_session_id,
       recipient_id, recipient_session_id, recipient_run_id)
      VALUES (?, ?, ?, 'inbound', 'feedback', ?, ?, 'reviewer', NULL, ?, ?, ?)`)
      .run(id, runId, `review:${id}`, JSON.stringify({ text: reason, outcome }), new Date().toISOString(),
        agentId, recipient?.session_id ?? null, runId);
    return id;
  });
}

export function readBridgedReviewFeedback(stateDir: string, runId: string): Array<{
  messageId: string; agentId: string; outcome: 'approved' | 'findings'; findings: string; createdAt: string;
}> {
  return withEventDb(stateDir, (db) => {
    const rows = db.prepare("SELECT message_id, recipient_id, payload, created_at FROM messages WHERE run_id = ? AND kind = 'feedback' AND sender_id = 'reviewer' ORDER BY created_at, rowid")
      .all(runId) as Array<{ message_id: string; recipient_id: string; payload: string; created_at: string }>;
    return rows.flatMap((row) => {
      const payload = JSON.parse(row.payload) as { text?: unknown; outcome?: unknown };
      if ((payload.outcome !== 'approved' && payload.outcome !== 'findings') || typeof payload.text !== 'string') return [];
      return [{ messageId: row.message_id, agentId: row.recipient_id, outcome: payload.outcome, findings: payload.text, createdAt: row.created_at }];
    });
  });
}
