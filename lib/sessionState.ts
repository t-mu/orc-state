import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { withLock } from './lock.ts';
import { atomicWriteJson } from './atomicWrite.ts';
import { appendSequencedEvent } from './eventLog.ts';
import type { Backlog, Task } from '../types/backlog.ts';
import type { AgentsState, Agent } from '../types/agents.ts';
import type { ClaimsState, Claim } from '../types/claims.ts';

function readBacklogState(stateDir: string): Backlog {
  return JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8')) as Backlog;
}

function readAgentsState(stateDir: string): AgentsState {
  return JSON.parse(readFileSync(join(stateDir, 'agents.json'), 'utf8')) as AgentsState;
}

function readClaimsState(stateDir: string): ClaimsState {
  return JSON.parse(readFileSync(join(stateDir, 'claims.json'), 'utf8')) as ClaimsState;
}

function resetTask(task: Task, now: string): boolean {
  if (task.status !== 'claimed' && task.status !== 'in_progress') return false;
  task.status = 'todo';
  delete task.blocked_reason;
  task.updated_at = now;
  return true;
}

function resetClaim(claim: Claim, now: string): boolean {
  if (claim.state !== 'claimed' && claim.state !== 'in_progress') return false;
  claim.state = 'failed';
  claim.failure_reason = 'session_reset';
  claim.finished_at = now;
  return true;
}

function resetAgent(agent: Agent, now: string): boolean {
  const nextStatus = agent.role === 'master' ? 'offline' : 'idle';
  const changed = agent.status !== nextStatus
    || agent.session_handle != null
    || agent.session_token != null
    || agent.session_started_at != null
    || agent.session_ready_at != null
    || agent.provider_ref != null
    || agent.last_heartbeat_at != null;
  if (!changed) return false;

  agent.status = nextStatus;
  agent.session_handle = null;
  agent.session_token = null;
  agent.session_started_at = null;
  agent.session_ready_at = null;
  agent.provider_ref = null;
  agent.last_heartbeat_at = null;
  agent.last_status_change_at = now;
  return true;
}

export interface SessionResetResult {
  session_id: string;
  reset_tasks: number;
  reset_claims: number;
  reset_agents: number;
}

export interface SessionStateSnapshot {
  backlog: Backlog;
  agents: AgentsState;
  claims: ClaimsState;
}

export interface PreparedSessionReset extends SessionResetResult {
  snapshot: SessionStateSnapshot;
}

export function resetVolatileRuntimeStateForSession(
  stateDir: string,
): PreparedSessionReset {
  return withLock(join(stateDir, '.lock'), () => {
    const now = new Date().toISOString();
    const sessionId = `session-${now.replace(/[-:.]/g, '').replace(/Z$/, 'Z')}-${randomUUID().slice(0, 8)}`;

    const backlog = readBacklogState(stateDir);
    const agents = readAgentsState(stateDir);
    const claims = readClaimsState(stateDir);
    const snapshot = {
      backlog: structuredClone(backlog),
      agents: structuredClone(agents),
      claims: structuredClone(claims),
    };

    let resetTasks = 0;
    for (const feature of backlog.features ?? []) {
      for (const task of feature.tasks ?? []) {
        if (resetTask(task, now)) resetTasks += 1;
      }
    }

    let resetClaims = 0;
    for (const claim of claims.claims ?? []) {
      if (resetClaim(claim, now)) resetClaims += 1;
    }

    let resetAgents = 0;
    for (const agent of agents.agents ?? []) {
      if (resetAgent(agent, now)) resetAgents += 1;
    }

    atomicWriteJson(join(stateDir, 'backlog.json'), backlog);
    atomicWriteJson(join(stateDir, 'claims.json'), claims);
    atomicWriteJson(join(stateDir, 'agents.json'), agents);

    return {
      session_id: sessionId,
      reset_tasks: resetTasks,
      reset_claims: resetClaims,
      reset_agents: resetAgents,
      snapshot,
    };
  });
}

/**
 * Build a PreparedSessionReset for a "reuse" session start: captures a
 * snapshot of the current state for error-recovery purposes but does NOT
 * mutate any runtime state (tasks, claims, or agents).
 */
export function prepareSessionReuse(stateDir: string): PreparedSessionReset {
  return withLock(join(stateDir, '.lock'), () => {
    const now = new Date().toISOString();
    const sessionId = `session-${now.replace(/[-:.]/g, '').replace(/Z$/, 'Z')}-${randomUUID().slice(0, 8)}`;
    const backlog = readBacklogState(stateDir);
    const agents = readAgentsState(stateDir);
    const claims = readClaimsState(stateDir);
    return {
      session_id: sessionId,
      reset_tasks: 0,
      reset_claims: 0,
      reset_agents: 0,
      snapshot: { backlog, agents, claims },
    };
  });
}

export function restoreVolatileRuntimeStateFromSnapshot(
  stateDir: string,
  snapshot: SessionStateSnapshot,
): void {
  withLock(join(stateDir, '.lock'), () => {
    atomicWriteJson(join(stateDir, 'backlog.json'), snapshot.backlog);
    atomicWriteJson(join(stateDir, 'claims.json'), snapshot.claims);
    atomicWriteJson(join(stateDir, 'agents.json'), snapshot.agents);
  });
}

export function appendSessionStartedEvent(
  stateDir: string,
  session: SessionResetResult,
  { actorId = 'human' }: { actorId?: string } = {},
): number {
  return withLock(join(stateDir, '.lock'), () =>
    appendSequencedEvent(
      stateDir,
      {
        ts: new Date().toISOString(),
        event: 'session_started',
        actor_type: 'human',
        actor_id: actorId,
        payload: {
          session_id: session.session_id,
          reset_tasks: session.reset_tasks,
          reset_claims: session.reset_claims,
          reset_agents: session.reset_agents,
        },
      },
      { lockAlreadyHeld: true },
    ));
}
