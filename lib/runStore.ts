import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { atomicWriteJson } from './atomicWrite.ts';
import { appendSequencedEvent, withEventDb, withEventDbTransaction } from './eventLog.ts';
import type { Claim, ClaimsState } from '../types/claims.ts';
import type { OrcEventInput } from '../types/events.ts';
import type { Agent, AgentsState } from '../types/agents.ts';
import { logger } from './logger.ts';

const CUTOVER_NAME = 'runs';
const SESSION_CUTOVER_NAME = 'sessions';

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

function importLegacyAgentSessions(db: Database.Database, stateDir: string): void {
  if (db.prepare('SELECT 1 FROM runtime_cutovers WHERE name = ?').get(SESSION_CUTOVER_NAME)) return;
  const path = join(stateDir, 'agents.json');
  if (!existsSync(path)) return;
  importLegacyClaims(db, stateDir);
  if (existsSync(join(stateDir, 'claims.json')) && !db.prepare('SELECT 1 FROM runtime_cutovers WHERE name = ?').get(CUTOVER_NAME)) return;
  const state = JSON.parse(readFileSync(path, 'utf8')) as AgentsState;
  for (const agent of state.agents) {
    if (!agent.session_handle || agent.status !== 'running') continue;
    const sessionId = agent.session_token
      || `legacy-${createHash('sha256').update(`${agent.agent_id}\0${agent.session_handle}`).digest('hex').slice(0, 24)}`;
    const run = db.prepare("SELECT run_id FROM runs WHERE agent_id = ? AND state IN ('claimed', 'in_progress') ORDER BY created_at DESC LIMIT 1")
      .get(agent.agent_id) as { run_id: string } | undefined;
    const startedAt = agent.session_started_at ?? agent.registered_at;
    db.prepare(`
      INSERT OR IGNORE INTO sessions (session_id, run_id, agent_id, provider, state, provider_ref, started_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(sessionId, run?.run_id ?? null, agent.agent_id, agent.provider,
      agent.provider_ref == null ? null : JSON.stringify(agent.provider_ref), startedAt, startedAt);
  }
  db.prepare("INSERT INTO runtime_cutovers (name, imported_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
    .run(SESSION_CUTOVER_NAME);
}

/** Overlay the stable provider session ID onto the legacy agent registry. */
export function withAuthoritativeAgentSessions(stateDir: string, state: AgentsState): AgentsState {
  if (!existsSync(join(stateDir, 'events.db'))) return state;
  const imported = withEventDb(stateDir, (db) => Boolean(db.prepare('SELECT 1 FROM runtime_cutovers WHERE name = ?').get(SESSION_CUTOVER_NAME)));
  if (!imported) withEventDbTransaction(stateDir, (db) => importLegacyAgentSessions(db, stateDir));
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
        return { ...agent, session_token: session.state === 'running' ? session.session_id : null };
      }),
    };
  });
}

/** Return the SQLite claim projection, or null until a legacy claims file exists. */
export function readAuthoritativeClaims(stateDir: string): ClaimsState | null {
  if (!existsSync(join(stateDir, 'events.db'))) return null;
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
}): boolean {
  if (session.sessionId === session.agentId || session.sessionId === session.runId) {
    throw new Error('Provider session ID must differ from agent and run IDs');
  }
  return withEventDbTransaction(stateDir, (db) => {
    importLegacyAgentSessions(db, stateDir);
    if (session.runId !== null && !db.prepare('SELECT 1 FROM runs WHERE run_id = ?').get(session.runId)) return false;
    db.prepare("UPDATE sessions SET state = 'offline', updated_at = ? WHERE agent_id = ? AND session_id <> ? AND state = 'running'")
      .run(session.startedAt, session.agentId, session.sessionId);
    db.prepare(`
      INSERT INTO sessions (session_id, run_id, agent_id, provider, state, provider_ref, started_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        state = 'running', provider_ref = excluded.provider_ref, updated_at = excluded.updated_at
    `).run(session.sessionId, session.runId, session.agentId, session.provider,
      session.providerRef == null ? null : JSON.stringify(session.providerRef), session.startedAt, session.startedAt);
    return true;
  });
}

export function closeProviderSessionsForAgent(stateDir: string, agentId: string, at: string): void {
  if (!existsSync(join(stateDir, 'events.db'))) return;
  withEventDbTransaction(stateDir, (db) => {
    importLegacyAgentSessions(db, stateDir);
    db.prepare("UPDATE sessions SET state = 'offline', updated_at = ? WHERE agent_id = ? AND state = 'running'").run(at, agentId);
  });
}

/** Restore the previous active session identities if a session reset is rolled back. */
export function restoreProviderSessionsForAgents(stateDir: string, agents: Agent[], at: string): void {
  if (!existsSync(join(stateDir, 'events.db'))) return;
  withEventDbTransaction(stateDir, (db) => {
    importLegacyAgentSessions(db, stateDir);
    const latest = db.prepare('SELECT session_id FROM sessions WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1');
    const reactivate = db.prepare("UPDATE sessions SET state = 'running', updated_at = ? WHERE session_id = ?");
    for (const agent of agents) {
      if (!agent.session_handle || agent.status !== 'running') continue;
      const session = latest.get(agent.agent_id) as { session_id: string } | undefined;
      if (session) reactivate.run(at, session.session_id);
    }
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
