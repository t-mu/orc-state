import { join } from 'node:path';
import { readEvents, eventIdentity } from './eventLog.ts';
import { readAgents, readBacklog, readClaims } from './stateReader.ts';
import type { Agent } from '../types/agents.ts';
import type { Task } from '../types/backlog.ts';
import type { Claim, FinalizationState } from '../types/claims.ts';

export interface LifecycleIssue {
  code:
    | 'duplicate_active_claims'
    | 'duplicate_active_agent_claims'
    | 'unknown_active_task_ref'
    | 'unknown_active_agent_id'
    | 'task_status_missing_active_claim'
    | 'task_status_claim_mismatch'
    | 'invalid_finalization_state'
    | 'missing_finalization_blocked_reason'
    | 'suspicious_finalization_retry_count'
    | 'duplicate_event_identity';
  message: string;
  hint?: string;
}

const ACTIVE_CLAIM_STATES = new Set<Claim['state']>(['claimed', 'in_progress']);
const ACTIVE_TASK_STATUSES = new Set<Task['status']>(['claimed', 'in_progress']);
const FINALIZATION_STATES = new Set<Exclude<FinalizationState, null>>([
  'awaiting_finalize',
  'finalize_rebase_requested',
  'finalize_rebase_in_progress',
  'ready_to_merge',
  'blocked_finalize',
]);

function activeClaims(claims: Claim[]): Claim[] {
  return claims.filter((claim) => ACTIVE_CLAIM_STATES.has(claim.state));
}

function expectedTaskStatus(claim: Claim): Task['status'] {
  return claim.state === 'in_progress' ? 'in_progress' : 'claimed';
}

function compareIsoAscending(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function selectDuplicateClaimWinner(claims: Claim[]): Claim {
  return [...claims].sort((left, right) => {
    const claimedAtOrder = compareIsoAscending(left.claimed_at, right.claimed_at);
    if (claimedAtOrder !== 0) return claimedAtOrder;
    return left.run_id.localeCompare(right.run_id, 'en');
  })[0];
}

export function detectLifecycleIssues(stateDir: string): LifecycleIssue[] {
  let backlog;
  let agents;
  let claims;
  try {
    backlog = readBacklog(stateDir);
    agents = readAgents(stateDir).agents;
    claims = readClaims(stateDir).claims;
  } catch {
    return [];
  }
  const tasksByRef = new Map<string, Task>();
  const agentIds = new Set<string>();
  const issues: LifecycleIssue[] = [];

  for (const feature of backlog.features ?? []) {
    for (const task of feature.tasks ?? []) {
      tasksByRef.set(task.ref, task);
    }
  }
  for (const agent of agents) {
    agentIds.add(agent.agent_id);
  }

  const activeByTask = new Map<string, Claim[]>();
  const activeByAgent = new Map<string, Claim[]>();
  for (const claim of activeClaims(claims)) {
    const taskClaims = activeByTask.get(claim.task_ref) ?? [];
    taskClaims.push(claim);
    activeByTask.set(claim.task_ref, taskClaims);

    const agentClaims = activeByAgent.get(claim.agent_id) ?? [];
    agentClaims.push(claim);
    activeByAgent.set(claim.agent_id, agentClaims);

    if (!tasksByRef.has(claim.task_ref)) {
      issues.push({
        code: 'unknown_active_task_ref',
        message: `active claim ${claim.run_id} references unknown task_ref "${claim.task_ref}"`,
        hint: 'Repair or reset the run before dispatch continues.',
      });
    }
    if (!agentIds.has(claim.agent_id)) {
      issues.push({
        code: 'unknown_active_agent_id',
        message: `active claim ${claim.run_id} references unknown agent_id "${claim.agent_id}"`,
        hint: 'Re-register the worker or reset the task claim.',
      });
    }
  }

  for (const [taskRef, duplicates] of activeByTask.entries()) {
    if (duplicates.length <= 1) continue;
    const winner = selectDuplicateClaimWinner(duplicates);
    const losers = duplicates
      .filter((claim) => claim.run_id !== winner.run_id)
      .map((claim) => claim.run_id)
      .join(', ');
    issues.push({
      code: 'duplicate_active_claims',
      message: `multiple active claims for task ${taskRef}; keep oldest run ${winner.run_id}, fail newer run(s): ${losers}`,
      hint: 'Coordinator reconcile should leave the oldest active claim and fail fresher duplicates.',
    });
  }

  for (const [agentId, duplicates] of activeByAgent.entries()) {
    if (duplicates.length <= 1) continue;
    issues.push({
      code: 'duplicate_active_agent_claims',
      message: `agent ${agentId} has multiple active claims: ${duplicates.map((claim) => claim.run_id).join(', ')}`,
      hint: 'A worker should own at most one active run at a time.',
    });
  }

  for (const task of tasksByRef.values()) {
    const duplicates = activeByTask.get(task.ref) ?? [];
    const activeClaim = duplicates.length > 0 ? selectDuplicateClaimWinner(duplicates) : null;
    if (ACTIVE_TASK_STATUSES.has(task.status) && !activeClaim) {
      issues.push({
        code: 'task_status_missing_active_claim',
        message: `task ${task.ref} is ${task.status} but has no active claim`,
        hint: 'Reset the task or repair claims/backlog state before continuing.',
      });
      continue;
    }
    if (!activeClaim) continue;

    const expectedStatus = expectedTaskStatus(activeClaim);
    if (task.status !== expectedStatus) {
      issues.push({
        code: 'task_status_claim_mismatch',
        message: `task ${task.ref} is ${task.status} but active claim ${activeClaim.run_id} is ${activeClaim.state}`,
        hint: `Expected task status ${expectedStatus} while that run is active.`,
      });
    }
  }

  for (const claim of claims) {
    const finalizationState = claim.finalization_state ?? null;
    const retryCount = claim.finalization_retry_count ?? 0;
    if (finalizationState != null && !FINALIZATION_STATES.has(finalizationState)) {
      issues.push({
        code: 'invalid_finalization_state',
        message: `claim ${claim.run_id} has unsupported finalization_state "${String(finalizationState)}"`,
      });
    }

    if (finalizationState != null && claim.state !== 'in_progress') {
      issues.push({
        code: 'invalid_finalization_state',
        message: `claim ${claim.run_id} has finalization_state "${finalizationState}" while state is ${claim.state}`,
        hint: 'Finalization state is only valid while a run remains in_progress.',
      });
    }

    if (finalizationState === 'blocked_finalize' && !(claim.finalization_blocked_reason ?? '').trim()) {
      issues.push({
        code: 'missing_finalization_blocked_reason',
        message: `claim ${claim.run_id} is blocked_finalize without a blocked reason`,
        hint: 'Preserved finalization failures should always record why they were blocked.',
      });
    }

    if (retryCount > 0 && finalizationState == null) {
      issues.push({
        code: 'suspicious_finalization_retry_count',
        message: `claim ${claim.run_id} has retry_count=${retryCount} without an active finalization_state`,
        hint: 'Retry counters should only be set while a finalization phase is active or preserved.',
      });
    }
  }

  try {
    const events = readEvents(join(stateDir, 'events.db'));
    const eventIds = new Set<string>();
    for (const event of events) {
      const identity = eventIdentity(event);
      if (eventIds.has(identity)) {
        issues.push({
          code: 'duplicate_event_identity',
          message: `events.db contains duplicate event identity ${identity}`,
          hint: 'Event replay and dedupe rely on unique identities within the retained log.',
        });
      } else {
        eventIds.add(identity);
      }
    }
  } catch {
    // Event-log parse/schema errors are reported by the existing validation surface.
  }

  return issues;
}

export function summarizeLifecycleIssues(issues: LifecycleIssue[]): string[] {
  return issues.map((issue) =>
    issue.hint
      ? `invariant: ${issue.message} (${issue.hint})`
      : `invariant: ${issue.message}`);
}

export function findTaskAgent(task: Task, agents: Agent[]): Agent | null {
  if (!task.owner) return null;
  return agents.find((agent) => agent.agent_id === task.owner) ?? null;
}
