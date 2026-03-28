import { readJson } from './stateReader.ts';
import { canAgentExecuteTask } from './taskRouting.ts';
import type { Backlog } from '../types/backlog.ts';
import type { Agent } from '../types/agents.ts';

const TASK_PRIORITY_RANK: Record<string, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

function priorityRank(priority: string | undefined): number {
  return TASK_PRIORITY_RANK[priority ?? ''] ?? TASK_PRIORITY_RANK['normal'];
}

/**
 * Find the next task the agent can execute.
 * Returns task_ref string, or null if nothing is eligible.
 */
export function nextEligibleTaskFromBacklog(
  backlog: unknown,
  agentOrId: Agent | string | null = null,
  { excludeTaskRefs = new Set<string>() }: { excludeTaskRefs?: ReadonlySet<string> } = {},
): string | null {
  const b = backlog as Backlog | null;
  const agentId = typeof agentOrId === 'string' ? agentOrId : (agentOrId?.agent_id ?? null);
  const agent: Agent = typeof agentOrId === 'string'
    ? { agent_id: agentId ?? '', provider: 'codex', role: 'worker', capabilities: [], status: 'idle', registered_at: '' }
    : (agentOrId ?? { agent_id: '', provider: 'codex', role: 'worker', capabilities: [], status: 'idle', registered_at: '' });
  const doneSet = new Set<string>();

  for (const feature of (b?.features ?? [])) {
    for (const task of (feature.tasks ?? [])) {
      if (task.status === 'done' || task.status === 'released') doneSet.add(task.ref);
    }
  }

  const eligible: Array<{ ref: string; rank: number; index: number }> = [];
  let index = 0;
  for (const feature of (b?.features ?? [])) {
    for (const task of (feature.tasks ?? [])) {
      if (task.status !== 'todo') continue;
      if (excludeTaskRefs.has(task.ref)) continue;
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

export function nextEligibleTask(
  stateDir: string,
  agentOrId: Agent | string | null = null,
  {
    backlog = null,
    agents = null,
    excludeTaskRefs = new Set<string>(),
  }: {
    backlog?: unknown;
    agents?: unknown;
    excludeTaskRefs?: ReadonlySet<string>;
  } = {},
): string | null {
  const backlogData = backlog ?? readJson(stateDir, 'backlog.json');
  if (typeof agentOrId === 'string') {
    let agent: Agent | null = null;
    try {
      const agentsFile = agents ?? readJson(stateDir, 'agents.json');
      const agentsArr = (agentsFile as { agents?: Agent[] })?.agents ?? [];
      agent = agentsArr.find((a) => a.agent_id === agentOrId) ?? null;
    } catch {
      agent = null;
    }
    return nextEligibleTaskFromBacklog(backlogData, agent ?? agentOrId, { excludeTaskRefs });
  }
  return nextEligibleTaskFromBacklog(backlogData, agentOrId, { excludeTaskRefs });
}
