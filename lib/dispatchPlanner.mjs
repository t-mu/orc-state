import { canAgentExecuteTask, evaluateTaskEligibility, formatRoutingReasons } from './taskRouting.mjs';
import { atomicWriteJson } from './atomicWrite.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DISPATCH_STATE_FILE = 'dispatch-state.json';

function readDispatchState(stateDir) {
  if (!stateDir) return null;
  const path = join(stateDir, DISPATCH_STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed?.last_assigned_agent_id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDispatchState(stateDir, lastAssignedAgentId) {
  if (!stateDir || !lastAssignedAgentId) return;
  const path = join(stateDir, DISPATCH_STATE_FILE);
  atomicWriteJson(path, {
    version: '1',
    last_assigned_agent_id: lastAssignedAgentId,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Return a filtered list of coordinator-visible agents that are dispatch-eligible.
 * The coordinator may supply config-backed worker slots here, not only
 * manually registered worker records.
 */
export function selectDispatchableAgents(agents, { busyAgents = new Set() } = {}) {
  return (agents ?? []).filter(
    (a) => a.status !== 'offline'
      && a.status !== 'dead'
      && a.role !== 'master'
      && !busyAgents.has(a.agent_id),
  );
}

/**
 * Build a deterministic dispatch plan by asking for each agent's next task.
 * Agents with no eligible task are skipped.
 */
export function buildDispatchPlan(agents, pickTaskForAgent) {
  const plan = [];
  for (const agent of agents ?? []) {
    const taskRef = pickTaskForAgent(agent);
    if (!taskRef) continue;
    plan.push({ agent, task_ref: taskRef });
  }
  return plan;
}

/**
 * Find the first dispatchable agent that can execute the given task.
 * claims is an array of claim objects.
 * Returns agent_id string, or null if no eligible agent exists.
 */
export function selectAutoTarget({ task, taskType, allAgents, claims, stateDir }) {
  const busyAgents = new Set(
    (claims ?? [])
      .filter((c) => ['claimed', 'in_progress'].includes(c.state))
      .map((c) => c.agent_id),
  );
  const eligible = selectDispatchableAgents(allAgents, { busyAgents }).filter(
    (a) => (!task.owner || task.owner === a.agent_id)
      && canAgentExecuteTask({ ...task, task_type: taskType }, a),
  );
  if (eligible.length === 0) return null;

  const state = readDispatchState(stateDir);
  const lastAssignedAgentId = state?.last_assigned_agent_id ?? null;
  const lastIndex = eligible.findIndex((agent) => agent.agent_id === lastAssignedAgentId);
  const nextTarget = lastIndex === -1
    ? eligible[0].agent_id
    : eligible[(lastIndex + 1) % eligible.length].agent_id;

  try {
    writeDispatchState(stateDir, nextTarget);
  } catch {
    // Dispatch should continue even if round-robin state persistence fails.
  }
  return nextTarget;
}

export function describeAutoTargetFailure({ task, taskType, allAgents, claims }) {
  const busyAgents = new Set(
    (claims ?? [])
      .filter((c) => ['claimed', 'in_progress'].includes(c.state))
      .map((c) => c.agent_id),
  );

  return (allAgents ?? [])
    .filter((agent) => agent.status !== 'dead' && agent.role !== 'master')
    .map((agent) => {
      const reasons = [];
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
