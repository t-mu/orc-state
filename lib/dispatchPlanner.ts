import { canAgentExecuteTask, evaluateTaskEligibility, formatRoutingReasons } from './taskRouting.ts';
import type { Agent } from '../types/agents.ts';
import type { Claim } from '../types/claims.ts';
import type { Task } from '../types/backlog.ts';

let lastAssignedAgentId: string | null = null;

/**
 * Return a filtered list of coordinator-visible agents that are dispatch-eligible.
 */
export function selectDispatchableAgents(
  agents: Agent[] | null | undefined,
  { busyAgents = new Set<string>() }: { busyAgents?: Set<string> } = {},
): Agent[] {
  return (agents ?? []).filter(
    (a) => a.status !== 'offline'
      && a.status !== 'dead'
      && a.role !== 'master'
      && a.role !== 'scout'
      && !busyAgents.has(a.agent_id),
  );
}

/**
 * Build a deterministic dispatch plan by asking for each agent's next task.
 * Agents with no eligible task are skipped.
 */
export function buildDispatchPlan(
  agents: Agent[] | null | undefined,
  pickTaskForAgent: (agent: Agent, reservedTaskRefs: ReadonlySet<string>) => string | null,
): Array<{ agent: Agent; task_ref: string }> {
  const plan: Array<{ agent: Agent; task_ref: string }> = [];
  const reservedTaskRefs = new Set<string>();
  for (const agent of agents ?? []) {
    const taskRef = pickTaskForAgent(agent, reservedTaskRefs);
    if (!taskRef) continue;
    plan.push({ agent, task_ref: taskRef });
    reservedTaskRefs.add(taskRef);
  }
  return plan;
}

/**
 * Find the first dispatchable agent that can execute the given task.
 * Returns agent_id string, or null if no eligible agent exists.
 */
export function selectAutoTarget({ task, taskType, allAgents, claims }: {
  task: Partial<Task>;
  taskType: string;
  allAgents: Agent[];
  claims: Claim[];
}): string | null {
  const busyAgents = new Set<string>(
    (claims ?? [])
      .filter((c) => ['claimed', 'in_progress'].includes(c.state))
      .map((c) => c.agent_id),
  );
  const eligible = selectDispatchableAgents(allAgents, { busyAgents }).filter(
    (a) => (!task.owner || task.owner === a.agent_id)
      && canAgentExecuteTask({ ...task, task_type: taskType }, a),
  );
  if (eligible.length === 0) return null;

  const lastIndex = eligible.findIndex((agent) => agent.agent_id === lastAssignedAgentId);
  const nextTarget = lastIndex === -1
    ? eligible[0].agent_id
    : eligible[(lastIndex + 1) % eligible.length].agent_id;

  lastAssignedAgentId = nextTarget;
  return nextTarget;
}

export function describeAutoTargetFailure({ task, taskType, allAgents, claims }: {
  task: Partial<Task>;
  taskType: string;
  allAgents: Agent[];
  claims: Claim[];
}): Array<{ agent_id: string; reasons: string[]; reason_messages: string[] }> {
  const busyAgents = new Set<string>(
    (claims ?? [])
      .filter((c) => ['claimed', 'in_progress'].includes(c.state))
      .map((c) => c.agent_id),
  );

  return (allAgents ?? [])
    .filter((agent) => agent.status !== 'dead' && agent.role !== 'master' && agent.role !== 'scout')
    .map((agent) => {
      const reasons: string[] = [];
      if (agent.status === 'offline') reasons.push('agent_offline');
      if (busyAgents.has(agent.agent_id)) reasons.push('agent_busy');
      const evaluation = evaluateTaskEligibility({ ...task, task_type: taskType }, agent);
      reasons.push(...evaluation.reasons);
      return {
        agent_id: agent.agent_id,
        reasons,
        reason_messages: [
          ...reasons
            .filter((reason) => reason === 'agent_offline' || reason === 'agent_busy')
            .map((reason) => reason === 'agent_offline' ? 'agent is offline' : 'agent already has an active run'),
          ...formatRoutingReasons(evaluation.reasons),
        ],
      };
    })
    .filter((entry) => entry.reasons.length > 0);
}
