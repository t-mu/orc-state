import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { withLock } from './lock.ts';
import { atomicWriteJson } from './atomicWrite.ts';
import { appendSequencedEvent } from './eventLog.ts';
import { findTask, readBacklog, readClaims } from './stateReader.ts';
import { failureTaskOutcome } from './claimLeaseManager.ts';
import { closeProviderSessionsForAgent, commitClaims, restoreProviderSessionsForAgents } from './runStore.ts';
import type { Backlog, Task } from '../types/backlog.ts';
import type { AgentsState, Agent } from '../types/agents.ts';
import type { ClaimsState, Claim } from '../types/claims.ts';
import type { OrcEventInput } from '../types/events.ts';
import { commitBacklog, restoreBacklogStatuses, type TaskStatusChange } from './projectTasks.ts';

function readBacklogState(stateDir: string): Backlog {
  // Through readBacklog so a project state directory reads SQLite, not a possibly stale projection file.
  return readBacklog(stateDir);
}

function readAgentsState(stateDir: string): AgentsState {
  return JSON.parse(readFileSync(join(stateDir, 'agents.json'), 'utf8')) as AgentsState;
}

function readClaimsState(stateDir: string): ClaimsState {
  return readClaims(stateDir);
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
  claim.finalization_state = null;
  claim.finalization_retry_count = 0;
  claim.finalization_blocked_reason = null;
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

export interface SessionStopResult {
  stopped: string[];
  failed: Array<{ agent_id: string; error: string }>;
}

/**
 * Stop every non-master session a reset is about to close (workers, scouts),
 * so no process keeps working on a run the reset fails. The master is left
 * alone: `orc start-session` resets only when no live master runs. Call before
 * `resetVolatileRuntimeStateForSession`; a failed stop is reported, not thrown.
 */
export async function stopSessionsForReset(
  stateDir: string,
  stop: (agent: Agent) => Promise<void>,
): Promise<SessionStopResult> {
  const result: SessionStopResult = { stopped: [], failed: [] };
  for (const agent of readAgentsState(stateDir).agents ?? []) {
    if (agent.role === 'master' || !agent.session_handle) continue;
    try {
      await stop(agent);
      result.stopped.push(agent.agent_id);
    } catch (error) {
      result.failed.push({ agent_id: agent.agent_id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
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
    const changes: Record<string, TaskStatusChange> = {};
    for (const feature of backlog.features ?? []) {
      for (const task of feature.tasks ?? []) {
        if (resetTask(task, now)) {
          resetTasks += 1;
          // Matches the run_failed (requeue) events emitted for the same runs below.
          changes[task.ref] = { cause: 'failure_requeue', actorId: 'human', reason: 'session_reset' };
        }
      }
    }

    let resetClaims = 0;
    const failedClaims: Claim[] = [];
    for (const claim of claims.claims ?? []) {
      if (resetClaim(claim, now)) {
        resetClaims += 1;
        failedClaims.push(claim);
      }
    }

    let resetAgents = 0;
    for (const agent of agents.agents ?? []) {
      if (resetAgent(agent, now)) resetAgents += 1;
    }

    commitBacklog(stateDir, backlog, changes);
    const events: OrcEventInput[] = failedClaims.map((claim) => ({
      ts: now, event: 'run_failed', actor_type: 'human', actor_id: 'human',
      run_id: claim.run_id, task_ref: claim.task_ref, agent_id: claim.agent_id,
      payload: { reason: 'session_reset', code: 'ERR_SESSION_RESET', policy: 'requeue', ...failureTaskOutcome(findTask(backlog, claim.task_ref)) },
    }));
    commitClaims(stateDir, claims, events);
    for (const agent of snapshot.agents.agents) {
      if (agent.session_handle) closeProviderSessionsForAgent(stateDir, agent.agent_id, now, { type: 'human', id: 'human' });
    }
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
    const current = readClaimsState(stateDir);
    const currentByRun = new Map(current.claims.map((claim) => [claim.run_id, claim]));
    const now = new Date().toISOString();
    const events = snapshot.claims.claims.flatMap<OrcEventInput>((claim) => {
      if (currentByRun.get(claim.run_id)?.state === claim.state) return [];
      if (claim.state === 'claimed') return [{
        ts: now, event: 'claim_created', actor_type: 'human', actor_id: 'human',
        run_id: claim.run_id, task_ref: claim.task_ref, agent_id: claim.agent_id,
        payload: { lease_expires_at: claim.lease_expires_at, reason: 'session_reset_rollback' },
      }];
      if (claim.state === 'in_progress') return [{
        ts: now, event: 'run_started', actor_type: 'human', actor_id: 'human',
        run_id: claim.run_id, task_ref: claim.task_ref, agent_id: claim.agent_id,
        payload: { reason: 'session_reset_rollback' },
      }];
      return [];
    });
    restoreBacklogStatuses(stateDir, snapshot.backlog, snapshot.claims.claims);
    // Upsert only: a reset fails existing runs and creates none, so there is nothing newer than the snapshot to drop.
    commitClaims(stateDir, snapshot.claims, events);
    restoreProviderSessionsForAgents(stateDir, snapshot.agents.agents, now);
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
