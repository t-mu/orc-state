import { describe, it, expect } from 'vitest';
import { buildDispatchPlan, selectDispatchableAgents } from './dispatchPlanner.ts';
import type { Agent } from '../types/index.ts';

function agent(agent_id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id,
    status: 'running',
    role: 'worker',
    session_handle: 'pty:worker',
    ...overrides,
  } as Agent;
}

describe('selectDispatchableAgents', () => {
  it('filters offline and busy agents', () => {
    const agents = [
      agent('agent-ready'),
      agent('agent-reviewer', { role: 'reviewer' }),
      agent('agent-offline', { status: 'offline' }),
      agent('agent-dead', { status: 'dead' }),
      agent('agent-no-session', { session_handle: null }),
      agent('agent-busy'),
    ];
    const filtered = selectDispatchableAgents(agents, {
      busyAgents: new Set(['agent-busy']),
    });
    expect(filtered.map((a) => a.agent_id)).toEqual(['agent-ready', 'agent-reviewer', 'agent-no-session']);
  });

  it('excludes master-role agents from dispatch', () => {
    const agents = [
      agent('worker-01', { role: 'worker', status: 'running', session_handle: 'h1' }),
      agent('master', { role: 'master', status: 'running', session_handle: 'h2' }),
    ];
    const result = selectDispatchableAgents(agents);
    expect(result.map((a) => a.agent_id)).toEqual(['worker-01']);
  });

  it('treats coordinator-managed slot ids as normal dispatch capacity', () => {
    const agents = [
      agent('orc-1'),
      agent('orc-2', { status: 'idle', session_handle: null }),
      agent('master', { role: 'master' }),
    ];

    const result = selectDispatchableAgents(agents, {
      busyAgents: new Set(['orc-2']),
    });

    expect(result.map((candidate) => candidate.agent_id)).toEqual(['orc-1']);
  });
});

describe('buildDispatchPlan', () => {
  it('continues scanning when an earlier agent has no eligible task', () => {
    const agents = [agent('agent-a'), agent('agent-b')];
    const plan = buildDispatchPlan(agents, (candidate) => {
      if (candidate.agent_id === 'agent-a') return null;
      return 'docs/task-2';
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].agent.agent_id).toBe('agent-b');
    expect(plan[0].task_ref).toBe('docs/task-2');
  });
});
