import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { atomicWriteJson } from './atomicWrite.ts';
import { appendSequencedEvent, withEventDb, withEventDbTransaction } from './eventLog.ts';
import type { Claim, ClaimsState } from '../types/claims.ts';
import type { ActorType, OrcEventInput } from '../types/events.ts';
import type { Agent, AgentsState } from '../types/agents.ts';
import { logger } from './logger.ts';

const CUTOVER_NAME = 'runs';

function rawClaims(stateDir: string): ClaimsState {
  return JSON.parse(readFileSync(join(stateDir, 'claims.json'), 'utf8')) as ClaimsState;
}

function upsertClaim(db: Database.Database, claim: Claim): void {
  const existing = db.prepare('SELECT task_ref, agent_id FROM runs WHERE run_id = ?').get(claim.run_id) as
    { task_ref: string; agent_id: string } | undefined;
  if (existing && (existing.task_ref !== claim.task_ref || existing.agent_id !== claim.agent_id)) {
    throw new Error(`Run ${claim.run_id} belongs to ${existing.task_ref}/${existing.agent_id}; refusing to overwrite it with ${claim.task_ref}/${claim.agent_id}`);
  }
  db.prepare(`
    INSERT INTO runs (run_id, task_ref, agent_id, state, created_at, updated_at, claim_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      state = excluded.state, updated_at = excluded.updated_at,
      claim_json = excluded.claim_json
  `).run(
    claim.run_id, claim.task_ref, claim.agent_id, claim.state,
    claim.claimed_at, claim.finished_at ?? claim.started_at ?? claim.last_heartbeat_at ?? claim.claimed_at,
    JSON.stringify(claim),
  );
}

function readRows(db: Database.Database): ClaimsState {
  const rows = db.prepare('SELECT claim_json FROM runs ORDER BY rowid').all() as Array<{ claim_json: string | null }>;
  return { version: '1', claims: rows.filter((row) => row.claim_json !== null).map((row) => JSON.parse(row.claim_json!) as Claim) };
}

function importLegacyClaims(db: Database.Database, stateDir: string): boolean {
  const imported = db.prepare('SELECT 1 FROM runtime_cutovers WHERE name = ?').get(CUTOVER_NAME);
  if (imported) return false;
  if (!existsSync(join(stateDir, 'claims.json'))) return false;
  const source = rawClaims(stateDir);
  const activeTasks = new Set<string>();
  for (const claim of source.claims) {
    if (claim.state === 'claimed' || claim.state === 'in_progress') {
      // Keep invalid legacy state visible to doctor/reconcile. Do not hide a
      // duplicate by silently choosing a winner during a read.
      if (activeTasks.has(claim.task_ref)) return false;
      activeTasks.add(claim.task_ref);
    }
  }
  for (const claim of source.claims) {
    upsertClaim(db, claim);
  }
  db.prepare("INSERT INTO runtime_cutovers (name, imported_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))").run(CUTOVER_NAME);
  return true;
}

/**
 * Overlay the agent's latest session row onto the registry: the row answers
 * whether the session is alive. An offline row clears `session_token` and
 * reports a `running` agent as `offline`; a recoverable or unknown row still
 * belongs to the agent. `session_handle` is kept as recorded: it names the
 * terminal (a dead pane stays in tmux) that cleanup still has to stop.
 */
export function withAuthoritativeAgentSessions(stateDir: string, state: AgentsState): AgentsState {
  if (!existsSync(join(stateDir, 'events.db'))) return state;
  return withEventDb(stateDir, (db) => {
    const sessions = db.prepare('SELECT agent_id, session_id, state FROM sessions ORDER BY rowid').all() as Array<{
      agent_id: string; session_id: string; state: string;
    }>;
    const latest = new Map(sessions.map((session) => [session.agent_id, session]));
    return {
      ...state,
      agents: state.agents.map((agent) => {
        const session = latest.get(agent.agent_id);
        if (!session) return agent;
        if (session.state !== 'offline') return { ...agent, session_token: session.session_id };
        return { ...agent, session_token: null, ...(agent.status === 'running' ? { status: 'offline' as const } : {}) };
      }),
    };
  });
}

/**
 * Return the SQLite claims, importing a migrated installation's claims.json
 * once; null while there is neither a run store nor a claims file, or when the
 * file could not be imported.
 */
export function readAuthoritativeClaims(stateDir: string): ClaimsState | null {
  if (!existsSync(join(stateDir, 'events.db')) && !existsSync(join(stateDir, 'claims.json'))) return null;
  const alreadyImported = withEventDb(stateDir, (db) => Boolean(db.prepare('SELECT 1 FROM runtime_cutovers WHERE name = ?').get(CUTOVER_NAME)));
  let imported = false;
  if (!alreadyImported && existsSync(join(stateDir, 'claims.json'))) {
    imported = withEventDbTransaction(stateDir, (db) => importLegacyClaims(db, stateDir));
  }
  const claims = withEventDb(stateDir, (db) =>
    db.prepare('SELECT 1 FROM runtime_cutovers WHERE name = ?').get(CUTOVER_NAME) ? readRows(db) : null);
  if (imported && claims) projectClaims(stateDir, claims);
  return claims;
}

/** Commit claim state and lifecycle events together, then refresh legacy JSON. */
export function commitClaims(stateDir: string, state: ClaimsState, events: OrcEventInput[] = []): void {
  const stored = withEventDbTransaction(stateDir, (db) => {
    importLegacyClaims(db, stateDir);
    for (const claim of state.claims) upsertClaim(db, claim);
    db.prepare("INSERT OR IGNORE INTO runtime_cutovers (name, imported_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
      .run(CUTOVER_NAME);
    for (const event of events) appendSequencedEvent(stateDir, event);
    return readRows(db);
  });
  projectClaims(stateDir, stored);
}

/** Who wrote a session row, as recorded on its event. */
export interface SessionActor { type: ActorType; id: string }

const COORDINATOR_ACTOR: SessionActor = { type: 'coordinator', id: 'coordinator' };
const SUPERSEDED_REASON = 'superseded by a new session';

/** A session row as its writes and events see it. */
export interface SessionRowSnapshot {
  session_id: string;
  agent_id: string;
  run_id: string | null;
  state: string;
  state_reason: string | null;
  transport: string | null;
  provider_ref: string | null;
  provider_conversation_id: string | null;
  generation: number;
}

/** The event a write appends instead of `session_state_changed` (e.g. `session_resumed`). */
export type SessionEventBuilder = (row: { before: SessionRowSnapshot; after: SessionRowSnapshot; taskRef: string | null }) => OrcEventInput;

const SESSION_COLUMN_RE = /^[a-z_]+$/;

function readSessionRow(db: Database.Database, sessionId: string): SessionRowSnapshot | undefined {
  return db.prepare(`SELECT session_id, agent_id, run_id, state, state_reason, transport, provider_ref, provider_conversation_id,
    generation FROM sessions WHERE session_id = ?`).get(sessionId) as SessionRowSnapshot | undefined;
}

function taskRefForRun(db: Database.Database, runId: string | null): string | null {
  if (!runId) return null;
  return (db.prepare('SELECT task_ref FROM runs WHERE run_id = ?').get(runId) as { task_ref: string } | undefined)?.task_ref ?? null;
}

function sessionEventEnvelope(row: SessionRowSnapshot, taskRef: string | null, at: string, actor: SessionActor) {
  return {
    ts: at, actor_type: actor.type, actor_id: actor.id, agent_id: row.agent_id,
    ...(row.run_id ? { run_id: row.run_id } : {}),
    ...(taskRef ? { task_ref: taskRef } : {}),
  };
}

/**
 * The one way to change an existing session row: apply `set` (and `increment`)
 * and append exactly one event in the caller's event-DB transaction, so an app
 * following events sees every session write. The event is
 * `session_state_changed` (from/to/reason/generation) unless `event` names
 * another. Returns the row after the write, or null when there is no such row.
 * Lease renewal (`renewSessionOwnership`) is the one write that skips it: it
 * only extends `owner_expires_at` and runs every tick.
 */
export function writeSessionRow(db: Database.Database, stateDir: string, sessionId: string, change: {
  set: Record<string, unknown>;
  increment?: Array<'generation' | 'resume_count'>;
  at: string;
  reason?: string | null;
  actor?: SessionActor;
  event?: SessionEventBuilder;
}): SessionRowSnapshot | null {
  const before = readSessionRow(db, sessionId);
  if (!before) return null;
  const columns = Object.keys(change.set);
  for (const column of [...columns, ...(change.increment ?? [])]) {
    if (!SESSION_COLUMN_RE.test(column)) throw new Error(`Invalid session column: ${column}`);
  }
  const assignments = [
    ...columns.map((column) => `${column} = ?`),
    ...(change.increment ?? []).map((column) => `${column} = ${column} + 1`),
    'updated_at = ?',
  ];
  db.prepare(`UPDATE sessions SET ${assignments.join(', ')} WHERE session_id = ?`)
    .run(...columns.map((column) => change.set[column]), change.at, sessionId);
  const after = readSessionRow(db, sessionId)!;
  const taskRef = taskRefForRun(db, after.run_id);
  const actor = change.actor ?? COORDINATOR_ACTOR;
  appendSequencedEvent(stateDir, change.event ? change.event({ before, after, taskRef }) : {
    ...sessionEventEnvelope(after, taskRef, change.at, actor),
    event: 'session_state_changed',
    payload: {
      session_id: sessionId, agent_id: after.agent_id,
      ...(after.run_id ? { run_id: after.run_id } : {}),
      from: before.state, to: after.state,
      ...(change.reason ? { reason: change.reason } : {}),
      generation: after.generation,
    },
  });
  return after;
}

/** Take every other open session of the agent offline, one event each. */
function supersedeAgentSessions(db: Database.Database, stateDir: string, agentId: string, keepSessionId: string | null, at: string,
  reason = SUPERSEDED_REASON, actor: SessionActor = COORDINATOR_ACTOR): void {
  const rows = db.prepare("SELECT session_id FROM sessions WHERE agent_id = ? AND state <> 'offline' ORDER BY rowid")
    .all(agentId) as Array<{ session_id: string }>;
  for (const row of rows) {
    if (row.session_id === keepSessionId) continue;
    writeSessionRow(db, stateDir, row.session_id, { set: { state: 'offline', state_reason: reason }, at, reason, actor });
  }
}

/**
 * Persist the provider session identity separately from its agent and run:
 * the agent's other open sessions are superseded and the row is inserted
 * (`session_opened`), or rewritten when it already exists. Returns false,
 * writing nothing, when the run no longer exists (it was cancelled meanwhile).
 */
export function recordProviderSession(stateDir: string, session: {
  sessionId: string;
  runId: string | null;
  agentId: string;
  provider: string;
  providerRef: unknown;
  startedAt: string;
  /** Supervision metadata (Task 202); absent for legacy callers. */
  transport?: string | null;
  processPid?: number | null;
  processStart?: string | null;
  ownerId?: string | null;
  ownerExpiresAt?: string | null;
  /** Hash of the session's secret (task 231); the secret itself is never stored. */
  credentialHash?: string | null;
  /** The provider's own conversation id, kept so a later launch can resume it. */
  providerConversationId?: string | null;
}): boolean {
  if (session.sessionId === session.agentId || session.sessionId === session.runId) {
    throw new Error('Provider session ID must differ from agent and run IDs');
  }
  return withEventDbTransaction(stateDir, (db) => {
    if (session.runId !== null && !db.prepare('SELECT 1 FROM runs WHERE run_id = ?').get(session.runId)) return false;
    supersedeAgentSessions(db, stateDir, session.agentId, session.sessionId, session.startedAt);
    const providerRef = session.providerRef == null ? null : JSON.stringify(session.providerRef);
    const process = {
      transport: session.transport ?? null, process_pid: session.processPid ?? null, process_start: session.processStart ?? null,
      owner_id: session.ownerId ?? null, owner_expires_at: session.ownerExpiresAt ?? null,
    };
    if (readSessionRow(db, session.sessionId)) {
      writeSessionRow(db, stateDir, session.sessionId, {
        set: {
          state: 'running', state_reason: null, provider_ref: providerRef, ...process,
          ...(session.credentialHash != null ? { credential_hash: session.credentialHash } : {}),
          ...(session.providerConversationId != null ? { provider_conversation_id: session.providerConversationId } : {}),
        },
        at: session.startedAt, reason: 'session recorded again',
      });
      return true;
    }
    db.prepare(`
      INSERT INTO sessions (session_id, run_id, agent_id, provider, state, provider_ref, started_at, updated_at,
        transport, process_pid, process_start, owner_id, owner_expires_at, state_reason, credential_hash, provider_conversation_id)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(session.sessionId, session.runId, session.agentId, session.provider, providerRef, session.startedAt, session.startedAt,
      process.transport, process.process_pid, process.process_start, process.owner_id, process.owner_expires_at,
      session.credentialHash ?? null, session.providerConversationId ?? null);
    const row = readSessionRow(db, session.sessionId)!;
    appendSequencedEvent(stateDir, {
      ...sessionEventEnvelope(row, taskRefForRun(db, row.run_id), session.startedAt, COORDINATOR_ACTOR),
      event: 'session_opened',
      payload: {
        session_id: row.session_id, agent_id: row.agent_id,
        ...(row.run_id ? { run_id: row.run_id } : {}),
        state: row.state, transport: row.transport, generation: row.generation,
      },
    });
    return true;
  });
}

/**
 * Bring a session back under its own id after its process was relaunched to
 * resume the provider conversation: the new process identity and credential
 * replace the old ones, `generation` and `resume_count` go up, and a
 * `session_resumed` event records it. Returns the new generation, or null when
 * no such session exists.
 */
export function resumeProviderSession(stateDir: string, session: {
  sessionId: string;
  providerRef: unknown;
  at: string;
  transport: string | null;
  processPid: number | null;
  processStart: string | null;
  credentialHash: string;
  actorId?: string;
}): number | null {
  return withEventDbTransaction(stateDir, (db) => {
    const row = readSessionRow(db, session.sessionId);
    if (!row) return null;
    const actor: SessionActor = { type: 'human', id: session.actorId ?? 'human' };
    supersedeAgentSessions(db, stateDir, row.agent_id, session.sessionId, session.at, SUPERSEDED_REASON, actor);
    const after = writeSessionRow(db, stateDir, session.sessionId, {
      set: {
        state: 'running', state_reason: null, exit_reason: null,
        provider_ref: session.providerRef == null ? null : JSON.stringify(session.providerRef),
        transport: session.transport, process_pid: session.processPid, process_start: session.processStart,
        owner_id: null, owner_expires_at: null, credential_hash: session.credentialHash,
      },
      increment: ['generation', 'resume_count'],
      at: session.at,
      event: ({ after }) => ({
        ...sessionEventEnvelope(after, null, session.at, actor),
        event: 'session_resumed',
        payload: {
          session_id: session.sessionId, agent_id: after.agent_id, generation: after.generation,
          ...(after.run_id ? { run_id: after.run_id } : {}),
          ...(after.provider_conversation_id ? { provider_conversation_id: after.provider_conversation_id } : {}),
        },
      }),
    })!;
    return after.generation;
  });
}

/**
 * Reopen the latest session of `agentId` whose recorded process is the live
 * one (`processPid`, `processStart`), after it was closed while that process
 * kept running: its credential authenticates again. Other open sessions of the
 * agent are superseded, and a `session_reconciled` event records the repair.
 * Returns the session's id and provider ref, or null when no closed session
 * matches the live process (a session without a recorded identity never does).
 */
export function reopenLiveSession(stateDir: string, {
  agentId, processPid, processStart, at, reason, actorId = 'human',
}: {
  agentId: string; processPid: number; processStart: string; at: string; reason: string; actorId?: string;
}): { sessionId: string; providerRef: unknown } | null {
  if (!existsSync(join(stateDir, 'events.db'))) return null;
  return withEventDbTransaction(stateDir, (db) => {
    const row = db.prepare(`SELECT session_id, state, provider_ref FROM sessions
      WHERE agent_id = ? AND process_pid = ? AND process_start = ? ORDER BY rowid DESC LIMIT 1`)
      .get(agentId, processPid, processStart) as { session_id: string; state: string; provider_ref: string | null } | undefined;
    if (!row || row.state !== 'offline') return null;
    const actor: SessionActor = { type: 'human', id: actorId };
    supersedeAgentSessions(db, stateDir, agentId, row.session_id, at, SUPERSEDED_REASON, actor);
    writeSessionRow(db, stateDir, row.session_id, {
      set: { state: 'running', state_reason: null, owner_id: null, owner_expires_at: null },
      at,
      event: ({ before, after, taskRef }) => ({
        ...sessionEventEnvelope(after, taskRef, at, actor),
        event: 'session_reconciled',
        payload: {
          session_id: row.session_id, state: 'running', previous_state: before.state, transport: after.transport, outcome: 'restored', reason,
          generation: after.generation,
        },
      }),
    });
    let providerRef: unknown = null;
    try { providerRef = row.provider_ref == null ? null : JSON.parse(row.provider_ref); } catch { /* unreadable ref: none */ }
    return { sessionId: row.session_id, providerRef };
  });
}

/** Close every open session of the agent (`session_state_changed` to offline, one per session). */
export function closeProviderSessionsForAgent(stateDir: string, agentId: string, at: string, actor: SessionActor = COORDINATOR_ACTOR): void {
  if (!existsSync(join(stateDir, 'events.db'))) return;
  withEventDbTransaction(stateDir, (db) => {
    supersedeAgentSessions(db, stateDir, agentId, null, at, 'session closed', actor);
  });
}

/** Restore the previous active session identities if a session reset is rolled back. */
export function restoreProviderSessionsForAgents(stateDir: string, agents: Agent[], at: string): void {
  if (!existsSync(join(stateDir, 'events.db'))) return;
  withEventDbTransaction(stateDir, (db) => {
    const latest = db.prepare('SELECT session_id, state FROM sessions WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1');
    for (const agent of agents) {
      if (!agent.session_handle || agent.status !== 'running') continue;
      const session = latest.get(agent.agent_id) as { session_id: string; state: string } | undefined;
      if (!session || session.state === 'running') continue;
      writeSessionRow(db, stateDir, session.session_id, {
        set: { state: 'running', state_reason: null }, at, reason: 'session reset rolled back', actor: { type: 'human', id: 'human' },
      });
    }
  });
}

/** Record that relaunching a session to resume its provider conversation failed; the session is left as it was. */
export function recordSessionResumeFailed(stateDir: string, sessionId: string, reason: string, actorId = 'human'): void {
  withEventDbTransaction(stateDir, (db) => {
    const row = db.prepare('SELECT agent_id, run_id, provider_conversation_id, generation FROM sessions WHERE session_id = ?')
      .get(sessionId) as { agent_id: string; run_id: string | null; provider_conversation_id: string | null; generation: number } | undefined;
    if (!row) return;
    appendSequencedEvent(stateDir, {
      ts: new Date().toISOString(), event: 'session_resume_failed', actor_type: 'human', actor_id: actorId, agent_id: row.agent_id,
      ...(row.run_id ? { run_id: row.run_id } : {}),
      payload: {
        session_id: sessionId, agent_id: row.agent_id, generation: row.generation, reason,
        ...(row.run_id ? { run_id: row.run_id } : {}),
        ...(row.provider_conversation_id ? { provider_conversation_id: row.provider_conversation_id } : {}),
      },
    });
  });
}

/** Repair a stale compatibility file after a crash between commit and projection. */
export function refreshClaimsProjection(stateDir: string): boolean {
  const authoritative = readAuthoritativeClaims(stateDir);
  if (!authoritative) return false;
  try {
    if (JSON.stringify(rawClaims(stateDir)) === JSON.stringify(authoritative)) return false;
  } catch { /* missing or corrupt projection */ }
  projectClaims(stateDir, authoritative);
  return true;
}

/** Projection failure cannot undo a committed lifecycle transition. */
function projectClaims(stateDir: string, state: ClaimsState): void {
  try {
    atomicWriteJson(join(stateDir, 'claims.json'), state);
  } catch (error) {
    logger.error('[runStore] claims.json projection failed; SQLite remains authoritative:', error);
  }
}
