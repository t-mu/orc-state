import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendSequencedEvent, withEventDb, withEventDbTransaction } from './eventLog.ts';
import { readProcessStart } from './processIdentity.ts';
import type { SessionInspection } from '../adapters/interface.ts';
import type { Agent } from '../types/agents.ts';

/**
 * Session states (Task 202). Only `running` sessions accept commands.
 * - recoverable: the process is alive but this coordinator cannot write to it.
 * - unknown: a live process could not be matched to the recorded identity.
 * - offline: the process exited or the session was superseded.
 */
export type SessionState = 'running' | 'recoverable' | 'unknown' | 'offline';

export interface SupervisedSession {
  session_id: string;
  run_id: string | null;
  agent_id: string;
  provider: string;
  state: SessionState;
  transport: string | null;
  process_pid: number | null;
  process_start: string | null;
  owner_id: string | null;
  owner_expires_at: string | null;
  state_reason: string | null;
  started_at: string;
  updated_at: string;
}

export interface ReconcileResult {
  session_id: string;
  agent_id: string;
  previous_state: SessionState;
  state: SessionState;
  outcome: 'adopted' | 'recoverable' | 'unknown' | 'exited' | 'superseded';
  reason: string | null;
}

/** Owners renew each coordinator tick; an expired lease means the owner stopped renewing. */
export const SESSION_OWNER_TTL_MS = 120_000;

let ownerId: string | null = null;

/** Identity of the current process as a session owner; stable for its lifetime. */
export function currentSessionOwnerId(): string {
  ownerId ??= `pid:${process.pid}:${readProcessStart(process.pid) ?? 'unknown'}`;
  return ownerId;
}

export function listSupervisedSessions(stateDir: string, states?: SessionState[]): SupervisedSession[] {
  if (!existsSync(join(stateDir, 'events.db'))) return [];
  return withEventDb(stateDir, (db) => {
    const rows = db.prepare(`SELECT session_id, run_id, agent_id, provider, state, transport, process_pid, process_start,
      owner_id, owner_expires_at, state_reason, started_at, updated_at FROM sessions ORDER BY rowid`).all() as SupervisedSession[];
    return states ? rows.filter((row) => states.includes(row.state)) : rows;
  });
}

/**
 * Persist a supervision decision with its audit event in one transaction.
 * A repeated decision with the same state and reason writes nothing.
 */
export function setSessionState(
  stateDir: string,
  sessionId: string,
  state: SessionState,
  reason: string | null,
  options: { ownerId?: string; ownerTtlMs?: number; outcome?: ReconcileResult['outcome'] } = {},
): boolean {
  return withEventDbTransaction(stateDir, (db) => {
    const session = db.prepare('SELECT session_id, run_id, agent_id, state, transport, state_reason, owner_id FROM sessions WHERE session_id = ?')
      .get(sessionId) as Pick<SupervisedSession, 'session_id' | 'run_id' | 'agent_id' | 'state' | 'transport' | 'state_reason' | 'owner_id'> | undefined;
    if (!session) return false;
    const nextOwner = options.ownerId ?? session.owner_id;
    if (session.state === state && session.state_reason === reason && session.owner_id === nextOwner) return false;
    const now = new Date();
    db.prepare(`UPDATE sessions SET state = ?, state_reason = ?, updated_at = ?, owner_id = ?, owner_expires_at = ?
      WHERE session_id = ?`).run(state, reason, now.toISOString(), nextOwner,
      options.ownerId ? new Date(now.getTime() + (options.ownerTtlMs ?? SESSION_OWNER_TTL_MS)).toISOString() : null, sessionId);
    const run = session.run_id
      ? db.prepare('SELECT task_ref FROM runs WHERE run_id = ?').get(session.run_id) as { task_ref: string } | undefined
      : undefined;
    appendSequencedEvent(stateDir, {
      ts: now.toISOString(), event: 'session_reconciled', actor_type: 'coordinator', actor_id: 'coordinator',
      agent_id: session.agent_id,
      ...(session.run_id ? { run_id: session.run_id } : {}),
      ...(run ? { task_ref: run.task_ref } : {}),
      payload: {
        session_id: sessionId, state, previous_state: session.state, transport: session.transport,
        ...(options.outcome ? { outcome: options.outcome } : {}),
        ...(reason ? { reason } : {}),
      },
    });
    return true;
  });
}

/** The agent's current (non-offline) session record, or null for legacy agents without one. */
export function currentSessionForAgent(stateDir: string, agentId: string): SupervisedSession | null {
  if (!existsSync(join(stateDir, 'events.db'))) return null;
  return withEventDb(stateDir, (db) => (db.prepare(`SELECT session_id, run_id, agent_id, provider, state, transport, process_pid,
    process_start, owner_id, owner_expires_at, state_reason, started_at, updated_at FROM sessions
    WHERE agent_id = ? AND state <> 'offline' ORDER BY rowid DESC LIMIT 1`).get(agentId) as SupervisedSession | undefined) ?? null);
}

export const IDENTITY_MISMATCH_REASON = 'live process does not match the recorded process identity';
export const UNWRITABLE_REASON = 'session is alive but not writable by this coordinator; stop it with orc worker-remove to relaunch';

/** True when a live inspection contradicts the recorded PID and start time. */
export function identityMismatch(session: SupervisedSession, inspection: SessionInspection | null): boolean {
  if (!inspection?.alive || session.process_pid == null || session.process_start == null) return false;
  return inspection.pid !== session.process_pid || inspection.processStart !== session.process_start;
}

/** Extend this owner's lease on the running sessions it supervises. */
export function renewSessionOwnership(stateDir: string, owner: string, ttlMs: number): number {
  if (!existsSync(join(stateDir, 'events.db'))) return 0;
  return withEventDbTransaction(stateDir, (db) => db.prepare(`UPDATE sessions SET owner_expires_at = ?
    WHERE state = 'running' AND owner_id = ?`).run(new Date(Date.now() + ttlMs).toISOString(), owner).changes);
}

/**
 * Decide a session's state from an inspection of the live process. A PID or
 * start time that differs from the recorded identity is never trusted, so a
 * reused PID cannot be adopted.
 */
export function classifySession(session: SupervisedSession, inspection: SessionInspection | null):
  Pick<ReconcileResult, 'state' | 'outcome' | 'reason'> {
  if (!inspection || !inspection.alive) {
    return { state: 'offline', outcome: 'exited', reason: inspection?.reason ?? 'session process exited' };
  }
  if (session.process_pid == null || session.process_start == null) {
    return {
      state: 'unknown', outcome: 'unknown',
      reason: 'no recorded process identity; cannot rule out PID reuse. Stop the worker (orc worker-remove) or wait for it to exit',
    };
  }
  if (identityMismatch(session, inspection)) {
    return { state: 'unknown', outcome: 'unknown', reason: IDENTITY_MISMATCH_REASON };
  }
  if (!inspection.writable) {
    return {
      state: 'recoverable', outcome: 'recoverable',
      reason: `${inspection.reason ?? 'session is alive but not writable'}; the worker keeps running. Stop it with orc worker-remove to relaunch`,
    };
  }
  return { state: 'running', outcome: 'adopted', reason: null };
}

/**
 * Reconcile durable session records with the live processes after a
 * coordinator (re)start. Nothing is killed: healthy writable sessions are
 * adopted, everything else gets an explicit state and reason.
 */
export async function reconcileSessions(
  stateDir: string,
  {
    owner,
    ownerTtlMs = SESSION_OWNER_TTL_MS,
    agents,
    inspect,
  }: {
    owner: string;
    ownerTtlMs?: number;
    agents: Agent[];
    inspect: (agent: Agent, session: SupervisedSession) => Promise<SessionInspection | null>;
  },
): Promise<ReconcileResult[]> {
  const byAgent = new Map(agents.map((agent) => [agent.agent_id, agent]));
  const results: ReconcileResult[] = [];
  for (const session of listSupervisedSessions(stateDir, ['running', 'recoverable', 'unknown'])) {
    const agent = byAgent.get(session.agent_id);
    // The foreground master session belongs to `orc start-session`, which records it (superseding the
    // previous one) and closes it when the master exits; the coordinator never launched it and holds no
    // handle for it, so it is not the coordinator's to supersede.
    if (agent?.role === 'master') continue;
    let decision: Pick<ReconcileResult, 'state' | 'outcome' | 'reason'>;
    if (!agent?.session_handle || agent.session_token !== session.session_id) {
      decision = { state: 'offline', outcome: 'superseded', reason: 'agent no longer references this session' };
    } else {
      decision = classifySession(session, await inspect(agent, session));
    }
    const changed = setSessionState(stateDir, session.session_id, decision.state, decision.reason, {
      outcome: decision.outcome,
      ...(decision.outcome === 'adopted' ? { ownerId: owner, ownerTtlMs } : {}),
    });
    if (changed || decision.state !== session.state) {
      results.push({ session_id: session.session_id, agent_id: session.agent_id, previous_state: session.state, ...decision });
    }
  }
  return results;
}
