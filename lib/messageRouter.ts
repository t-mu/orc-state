import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { withEventDb, withEventDbTransaction } from './eventLog.ts';
import type { CommandPrincipal, CommandDispatcher } from './commandDelivery.ts';

export type MessageKind = 'message' | 'question' | 'review_request' | 'feedback' | 'result';
export interface SemanticMessage {
  message_id: string;
  run_id: string;
  command_id: string | null;
  idempotency_key: string;
  direction: 'outbound';
  kind: MessageKind;
  payload: string;
  created_at: string;
  sender_id: string;
  sender_session_id: string;
  recipient_id: string;
  recipient_session_id: string;
  recipient_run_id: string | null;
  parent_message_id: string | null;
  state: 'queued' | 'consumed';
  consumed_at: string | null;
}
export interface SendMessageInput {
  runId: string;
  recipientSessionId: string;
  idempotencyKey: string;
  kind: MessageKind;
  text: string;
  artifactRefs?: string[];
  parentMessageId?: string;
}
const KINDS = new Set<MessageKind>(['message', 'question', 'review_request', 'feedback', 'result']);
type Session = { session_id: string; run_id: string | null; agent_id: string; state: string };

function session(db: Database.Database, id: string): Session {
  const row = db.prepare('SELECT session_id, run_id, agent_id, state FROM sessions WHERE session_id = ?').get(id) as Session | undefined;
  if (!row || row.state !== 'running') throw new Error('Message session is not running');
  return row;
}

function ownedRun(db: Database.Database, runId: string, agentId: string): void {
  const row = db.prepare('SELECT agent_id, state FROM runs WHERE run_id = ?').get(runId) as { agent_id: string; state: string } | undefined;
  if (!row || !['claimed', 'in_progress'].includes(row.state) || row.agent_id !== agentId) throw new Error('Message run is not active or owned by recipient');
}

function read(db: Database.Database, id: string): SemanticMessage {
  const row = db.prepare('SELECT * FROM messages WHERE message_id = ?').get(id) as SemanticMessage | undefined;
  if (!row) throw new Error('Message not found');
  return row;
}

/** Text remains data; only a fixed semantic kind can be routed. */
export function sendMessage(stateDir: string, principal: CommandPrincipal, input: SendMessageInput, commands?: CommandDispatcher): SemanticMessage {
  if (!input.idempotencyKey || !KINDS.has(input.kind) || typeof input.text !== 'string' || !input.text.trim()) throw new Error('Invalid semantic message');
  if (input.kind === 'review_request' && (!Array.isArray(input.artifactRefs) || !input.artifactRefs.length
    || input.artifactRefs.some((ref) => typeof ref !== 'string' || !ref.trim()))) {
    throw new Error('Review request requires artifact references');
  }
  if (input.artifactRefs && (!Array.isArray(input.artifactRefs) || input.artifactRefs.some((ref) => typeof ref !== 'string'))) throw new Error('Invalid artifact references');
  if (input.parentMessageId !== undefined && (typeof input.parentMessageId !== 'string' || !input.parentMessageId)) throw new Error('Invalid parent message');
  const payload = JSON.stringify({ text: input.text, artifact_refs: input.artifactRefs ?? [] });
  const message = withEventDbTransaction(stateDir, (db) => {
    const sender = session(db, principal.sessionId);
    if (sender.agent_id !== principal.agentId || (sender.agent_id !== 'master' && sender.run_id !== input.runId)) throw new Error('Message sender is not scoped to the run');
    const recipient = session(db, input.recipientSessionId);
    if (recipient.run_id) ownedRun(db, recipient.run_id, recipient.agent_id);
    else if (recipient.agent_id !== 'master') throw new Error('Message recipient has no active run');
    if (sender.agent_id !== 'master') ownedRun(db, input.runId, sender.agent_id);
    else if (!recipient.run_id || recipient.run_id !== input.runId) throw new Error('Master message must target its run');
    if (input.kind === 'review_request' && (!sender.run_id || !recipient.run_id || sender.session_id === recipient.session_id)) throw new Error('Review requires two worker sessions');
    if (input.kind === 'result' && !input.parentMessageId) throw new Error('Result requires a parent message');
    if (input.parentMessageId) {
      const parent = read(db, input.parentMessageId);
      if (input.kind === 'result' && parent.kind !== 'review_request') throw new Error('Review result requires a review request');
      if (parent.sender_id !== recipient.agent_id || parent.recipient_id !== sender.agent_id
        || parent.run_id !== (recipient.run_id ?? input.runId) || parent.recipient_run_id !== sender.run_id) {
        throw new Error('Message reply is not scoped to its request');
      }
    }
    const existing = db.prepare('SELECT * FROM messages WHERE idempotency_key = ?').get(input.idempotencyKey) as SemanticMessage | undefined;
    if (existing) {
      if (existing.run_id !== input.runId || existing.sender_id !== sender.agent_id || existing.recipient_id !== recipient.agent_id
        || existing.recipient_run_id !== recipient.run_id
        || existing.kind !== input.kind || existing.payload !== payload || existing.parent_message_id !== (input.parentMessageId ?? null)) throw new Error('Message idempotency key conflicts');
      if (existing.recipient_session_id !== recipient.session_id && existing.state === 'queued') {
        db.prepare('UPDATE messages SET recipient_session_id = ?, command_id = NULL WHERE message_id = ?').run(recipient.session_id, existing.message_id);
        return read(db, existing.message_id);
      }
      return existing;
    }
    const id = `msg-${randomUUID()}`;
    db.prepare(`INSERT INTO messages
      (message_id, run_id, idempotency_key, direction, kind, payload, created_at, sender_id, sender_session_id,
       recipient_id, recipient_session_id, recipient_run_id, parent_message_id)
       VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.runId, input.idempotencyKey, input.kind, payload,
      new Date().toISOString(), sender.agent_id, sender.session_id, recipient.agent_id, recipient.session_id, recipient.run_id, input.parentMessageId ?? null);
    return read(db, id);
  });
  if (message.recipient_run_id && commands && !message.command_id) {
    const command = commands.enqueueFromCoordinator({ runId: message.recipient_run_id, recipientSessionId: message.recipient_session_id,
      idempotencyKey: `message:${message.message_id}:${message.recipient_session_id}`, kind: 'semantic_message', payload: { message_id: message.message_id }, sideEffecting: false });
    return withEventDbTransaction(stateDir, (db) => {
      db.prepare('UPDATE messages SET command_id = ? WHERE message_id = ? AND command_id IS NULL').run(command.command_id, message.message_id);
      return read(db, message.message_id);
    });
  }
  return message;
}

export function listMessages(stateDir: string, principal: CommandPrincipal, includeConsumed = false): SemanticMessage[] {
  return withEventDb(stateDir, (db) => {
    const actor = session(db, principal.sessionId);
    if (actor.agent_id !== principal.agentId) throw new Error('Message actor does not match session');
    return db.prepare(`SELECT * FROM messages WHERE recipient_id = ? AND recipient_run_id IS ? ${includeConsumed ? '' : "AND state = 'queued'"} ORDER BY created_at, rowid`)
      .all(actor.agent_id, actor.run_id) as SemanticMessage[];
  });
}

export function consumeMessage(stateDir: string, principal: CommandPrincipal, messageId: string): SemanticMessage {
  return withEventDbTransaction(stateDir, (db) => {
    const actor = session(db, principal.sessionId);
    const message = read(db, messageId);
    if (actor.agent_id !== principal.agentId || actor.agent_id !== message.recipient_id || actor.run_id !== message.recipient_run_id) throw new Error('Message recipient does not match session');
    db.prepare("UPDATE messages SET state = 'consumed', consumed_at = coalesce(consumed_at, ?) WHERE message_id = ?")
      .run(new Date().toISOString(), messageId);
    return read(db, messageId);
  });
}
