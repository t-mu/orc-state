import { readJson } from './stateReader.mjs';
import { canAgentExecuteTask } from './taskRouting.mjs';

const TASK_PRIORITY_RANK = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

function priorityRank(priority) {
  return TASK_PRIORITY_RANK[priority] ?? TASK_PRIORITY_RANK.normal;
}

/**
 * Find the next task the agent can execute.
 * Returns task_ref string, or null if nothing is eligible.
 */
export function nextEligibleTaskFromBacklog(backlog, agentOrId = null) {
  const agentId = typeof agentOrId === 'string' ? agentOrId : (agentOrId?.agent_id ?? null);
  const agent = typeof agentOrId === 'string'
    ? { agent_id: agentId, role: 'worker', capabilities: [] }
    : agentOrId;
  const doneSet = new Set();

  for (const epic of (backlog?.epics ?? [])) {
    for (const task of (epic.tasks ?? [])) {
      if (task.status === 'done' || task.status === 'released') doneSet.add(task.ref);
    }
  }

  const eligible = [];
  let index = 0;
  for (const epic of (backlog?.epics ?? [])) {
    for (const task of (epic.tasks ?? [])) {
      if (task.status !== 'todo') continue;
      if (task.planning_state && task.planning_state !== 'ready_for_dispatch') continue;
      if (task.owner && agentId && task.owner !== agentId) continue;
      if (task.owner && !agentId) continue;
      if (!canAgentExecuteTask(task, agent)) continue;
      const deps = task.depends_on ?? [];
      if (!deps.every((d) => doneSet.has(d))) continue;
      eligible.push({
        ref: task.ref,
        rank: priorityRank(task.priority),
        index,
      });
      index += 1;
    }
  }

  if (eligible.length === 0) return null;
  eligible.sort((a, b) => b.rank - a.rank || a.index - b.index);
  return eligible[0].ref;
}

export function nextEligibleTask(stateDir, agentOrId = null, { backlog = null, agents = null } = {}) {
  const backlogData = backlog ?? readJson(stateDir, 'backlog.json');
  if (typeof agentOrId === 'string') {
    let agent = null;
    try {
      const agentsFile = agents ?? readJson(stateDir, 'agents.json');
      agent = (agentsFile.agents ?? []).find((a) => a.agent_id === agentOrId) ?? null;
    } catch {
      agent = null;
    }
    return nextEligibleTaskFromBacklog(backlogData, agent ?? agentOrId);
  }
  return nextEligibleTaskFromBacklog(backlogData, agentOrId);
}
