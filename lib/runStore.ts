import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { atomicWriteJson } from './atomicWrite.ts';
import { appendSequencedEvent, withEventDb, withEventDbTransaction } from './eventLog.ts';
import type { Claim, ClaimsState } from '../types/claims.ts';
import type { OrcEventInput } from '../types/events.ts';
import type { Agent, AgentsState } from '../types/agents.ts';
import { logger } from './logger.ts';

const CUTOVER_NAME = 'runs';

function rawClaims(stateDir: string): ClaimsState {
  return JSON.parse(readFileSync(join(stateDir, 'claims.json'), 'utf8')) as ClaimsState;
}

function upsertClaim(db: Database.Database, claim: Claim): void {
  db.prepare(`
    INSERT INTO runs (run_id, task_ref, agent_id, state, created_at, updated_at, claim_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      task_ref = excluded.task_ref, agent_id = excluded.agent_id,
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

/** Overlay the stable provider session ID onto the agent registry. */
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
        // Recoverable and unknown sessions still belong to the agent; only offline ones are cleared.
        return { ...agent, session_token: session.state !== 'offline' ? session.session_id : null };
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
  withEventDbTransaction(stateDir, (db) => {
    importLegacyClaims(db, stateDir);
    const desired = new Set(state.claims.map((claim) => claim.run_id));
    const existing = db.prepare('SELECT run_id FROM runs').all() as Array<{ run_id: string }>;
    const remove = db.prepare('DELETE FROM runs WHERE run_id = ?');
    for (const row of existing) if (!desired.has(row.run_id)) remove.run(row.run_id);
    for (const claim of state.claims) upsertClaim(db, claim);
    db.prepare("INSERT OR IGNORE INTO runtime_cutovers (name, imported_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
      .run(CUTOVER_NAME);
    for (const event of events) appendSequencedEvent(stateDir, event);
  });
  projectClaims(stateDir, state);
}

/** Persist the provider session identity separately from its agent and run. */
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
    db.prepare("UPDATE sessions SET state = 'offline', state_reason = 'superseded by a new session', updated_at = ? WHERE agent_id = ? AND session_id <> ? AND state <> 'offline'")
      .run(session.startedAt, session.agentId, session.sessionId);
    db.prepare(`
      INSERT INTO sessions (session_id, run_id, agent_id, provider, state, provider_ref, started_at, updated_at,
        transport, process_pid, process_start, owner_id, owner_expires_at, state_reason, credential_hash, provider_conversation_id)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        state = 'running', provider_ref = excluded.provider_ref, updated_at = excluded.updated_at,
        transport = excluded.transport, process_pid = excluded.process_pid, process_start = excluded.process_start,
        owner_id = excluded.owner_id, owner_expires_at = excluded.owner_expires_at, state_reason = NULL,
        credential_hash = COALESCE(excluded.credential_hash, sessions.credential_hash),
        provider_conversation_id = COALESCE(excluded.provider_conversation_id, sessions.provider_conversation_id)
    `).run(session.sessionId, session.runId, session.agentId, session.provider,
      session.providerRef == null ? null : JSON.stringify(session.providerRef), session.startedAt, session.startedAt,
      session.transport ?? null, session.processPid ?? null, session.processStart ?? null,
      session.ownerId ?? null, session.ownerExpiresAt ?? null, session.credentialHash ?? null,
      session.providerConversationId ?? null);
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
    const row = db.prepare('SELECT agent_id, run_id, provider_conversation_id FROM sessions WHERE session_id = ?')
      .get(session.sessionId) as { agent_id: string; run_id: string | null; provider_conversation_id: string | null } | undefined;
    if (!row) return null;
    db.prepare("UPDATE sessions SET state = 'offline', state_reason = 'superseded by a new session', updated_at = ? WHERE agent_id = ? AND session_id <> ? AND state <> 'offline'")
      .run(session.at, row.agent_id, session.sessionId);
    db.prepare(`UPDATE sessions SET state = 'running', state_reason = NULL, exit_reason = NULL, provider_ref = ?, updated_at = ?,
        transport = ?, process_pid = ?, process_start = ?, owner_id = NULL, owner_expires_at = NULL, credential_hash = ?,
        generation = generation + 1, resume_count = resume_count + 1
      WHERE session_id = ?`).run(session.providerRef == null ? null : JSON.stringify(session.providerRef), session.at,
      session.transport, session.processPid, session.processStart, session.credentialHash, session.sessionId);
    const { generation } = db.prepare('SELECT generation FROM sessions WHERE session_id = ?').get(session.sessionId) as { generation: number };
    const actorId = session.actorId ?? 'human';
    appendSequencedEvent(stateDir, {
      ts: session.at, event: 'session_resumed', actor_type: 'human', actor_id: actorId, agent_id: row.agent_id,
      ...(row.run_id ? { run_id: row.run_id } : {}),
      payload: {
        session_id: session.sessionId, agent_id: row.agent_id, generation,
        ...(row.run_id ? { run_id: row.run_id } : {}),
        ...(row.provider_conversation_id ? { provider_conversation_id: row.provider_conversation_id } : {}),
      },
    });
    return generation;
  });
}

export function closeProviderSessionsForAgent(stateDir: string, agentId: string, at: string): void {
  if (!existsSync(join(stateDir, 'events.db'))) return;
  withEventDbTransaction(stateDir, (db) => {
    db.prepare("UPDATE sessions SET state = 'offline', state_reason = 'session closed', updated_at = ? WHERE agent_id = ? AND state <> 'offline'").run(at, agentId);
  });
}

/** Restore the previous active session identities if a session reset is rolled back. */
export function restoreProviderSessionsForAgents(stateDir: string, agents: Agent[], at: string): void {
  if (!existsSync(join(stateDir, 'events.db'))) return;
  withEventDbTransaction(stateDir, (db) => {
    const latest = db.prepare('SELECT session_id FROM sessions WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1');
    const reactivate = db.prepare("UPDATE sessions SET state = 'running', updated_at = ? WHERE session_id = ?");
    for (const agent of agents) {
      if (!agent.session_handle || agent.status !== 'running') continue;
      const session = latest.get(agent.agent_id) as { session_id: string } | undefined;
      if (session) reactivate.run(at, session.session_id);
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
