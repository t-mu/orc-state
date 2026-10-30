/**
 * Routing helpers for task-to-agent compatibility.
 */
import { TASK_TYPES } from './constants.ts';
import { logger } from './logger.ts';

interface AgentLike {
  agent_id?: string | undefined;
  role?: string | undefined;
  provider?: string | undefined;
}

interface TaskLike {
  task_type?: string | undefined;
  owner?: string | undefined;
  required_provider?: string | undefined;
}

const KNOWN_TASK_TYPES = new Set(TASK_TYPES);

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function describeReason(reason: string): string {
  if (reason.startsWith('unsupported_task_type:')) {
    return `unsupported task type '${reason.split(':', 2)[1]}'`;
  }
  if (reason.startsWith('role_ineligible:')) {
    return `agent role '${reason.split(':', 2)[1]}' cannot execute routed tasks`;
  }
  if (reason.startsWith('reserved_owner_conflict:')) {
    return `task is reserved for owner '${reason.split(':', 2)[1]}'`;
  }
  if (reason.startsWith('provider_mismatch:')) {
    return `task requires provider '${reason.split(':', 2)[1]}'`;
  }
  return reason;
}

export function taskTypeOf(task: TaskLike | null | undefined): string {
  return task?.task_type ?? 'implementation';
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
  reason_details: Array<{ code: string; message: string }>;
}

export function evaluateTaskEligibility(task: TaskLike | null | undefined, agent: AgentLike | null | undefined): EligibilityResult {
  const reasons: string[] = [];
  const taskType = taskTypeOf(task);

  if (!KNOWN_TASK_TYPES.has(taskType)) {
    addReason(reasons, `unsupported_task_type:${taskType}`);
  }

  const role = agent?.role ?? 'worker';
  if (role === 'master' || role === 'scout') {
    addReason(reasons, `role_ineligible:${role}`);
  }

  if (task?.owner && task.owner !== agent?.agent_id) {
    addReason(reasons, `reserved_owner_conflict:${task.owner}`);
  }

  if (task?.required_provider && task.required_provider !== agent?.provider) {
    addReason(reasons, `provider_mismatch:${task.required_provider}`);
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    reason_details: reasons.map((reason) => ({
      code: reason,
      message: describeReason(reason),
    })),
  };
}

export function formatRoutingReasons(reasons: string[] | null | undefined): string[] {
  return (reasons ?? []).map(describeReason);
}

export function canAgentExecuteTaskType(taskType: unknown, agent: AgentLike | null | undefined): boolean {
  const result = evaluateTaskEligibility({ task_type: String(taskType) }, agent);
  if (result.reasons.some((reason) => reason.startsWith('unsupported_task_type:'))) {
    logger.warn(`[taskRouting] unknown task type encountered: ${String(taskType)}`);
    return false;
  }
  return !result.reasons.some((reason) => reason.startsWith('role_ineligible:'));
}

export function canAgentExecuteTask(task: TaskLike | null | undefined, agent: AgentLike | null | undefined): boolean {
  return evaluateTaskEligibility(task, agent).eligible;
}
