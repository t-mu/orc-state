import { describe, expect, it } from 'vitest';
import {
  agentLines, agentTaskLine, buildDashboardModel, buildDashboardProject, computeDashboardLayout, mergeFeed, notificationEntries,
  type DashboardAgent, type DashboardFeedEntry, type DashboardModel, type DashboardProject,
} from './dashboard.ts';

function entry(key: string, ts: string | null, seq: number | null = null): DashboardFeedEntry {
  return { key, project: 'p', seq, ts, event: 'run_finished', agent_id: null, task_ref: null, reason: null };
}

function projectWith(agents: number, id = 'p'): DashboardProject {
  return {
    project_id: id, name: id, state_dir: '/state/p', target_repo_root: '/repo/p', current: true, connection: 'running', error: null, stale: false,
    agents: Array.from({ length: agents }, (_, i) => ({
      key: `${id}/a${i}`, agent_id: `a${i}`, role: 'worker', task_ref: `plan/t${i}`, state: 'in_progress', phase: 'implement', activity: 'working', attention: null,
    })),
    attention: { permission_prompt: 0, question: 0, stalled: 0, no_progress: 0 },
    attentionTotal: 0,
  };
}

function model(agents: number, feed = 0): DashboardModel {
  return { projects: [projectWith(agents)], feed: Array.from({ length: feed }, (_, i) => entry(`e${i}`, null, i)), notice: null };
}

describe('notification feed', () => {
  it('keeps only notification events, keyed by project and seq, with the attention reason', () => {
    const entries = notificationEntries({ project_id: 'p1', name: 'one' }, [
      { seq: 1, event: 'heartbeat' },
      { seq: 2, ts: '2026-11-09T10:00:00Z', event: 'worker_needs_attention', agent_id: 'w', payload: { reason: 'stale' } } as never,
      { event: 'run_failed', ts: '2026-11-09T10:01:00Z', run_id: 'r' },
    ]);
    expect(entries.map(e => [e.key, e.event, e.reason])).toEqual([
      ['p1:2', 'worker_needs_attention', 'stale'],
      ['p1:2026-11-09T10:01:00Z:run_failed:r:', 'run_failed', null],
    ]);
  });

  it('merges by key, orders oldest first by time and keeps the newest `limit`', () => {
    const merged = mergeFeed(
      [entry('a', '2026-11-09T10:00:00Z'), entry('b', '2026-11-09T10:02:00Z')],
      [entry('b', '2026-11-09T10:02:00Z'), entry('c', '2026-11-09T10:01:00Z')],
      2,
    );
    expect(merged.map(e => e.key)).toEqual(['c', 'b']);
  });

  it('says so when there is no project or the registry is unreadable', () => {
    expect(buildDashboardModel([], '/s', [], null).notice).toBe('no registered projects');
    expect(buildDashboardModel([], '/s', [], 'EACCES').notice).toBe('registry error: EACCES');
  });
});

describe('buildDashboardProject', () => {
  it('lists the master as a selectable agent, with the project paths an opened terminal needs', () => {
    const view = {
      project_id: 'p', name: 'p', target_repo_root: '/repo/p', state_dir: '/state/p', connection: 'running' as const, error: null, stale: false,
      status: {
        master: { agent_id: 'master', status: 'running' },
        worker_capacity: { slots: [] }, claims: { active: [] }, waiting_input: [],
      } as never,
    };
    const project = buildDashboardProject(view, true);
    expect(project.agents).toEqual([{
      key: 'p/master', agent_id: 'master', role: 'master', task_ref: null, state: 'running', phase: null, activity: null, attention: null,
    }]);
    expect([project.state_dir, project.target_repo_root]).toEqual(['/state/p', '/repo/p']);
  });
});

describe('computeDashboardLayout', () => {
  it('shows everything without a terminal height', () => {
    expect(computeDashboardLayout(model(50, 20), undefined)).toEqual({ detail: 'full', maxAgentsPerProject: Infinity, maxProjects: Infinity, feedLines: 20 });
  });

  it('uses full agent rows when they fit, giving the rest to the feed', () => {
    // title 1 + project 1 + 2 agents × 3 + gap 1 = 9; feed title 1; 20 - 1 - 9 - 1 = 9 entries.
    expect(computeDashboardLayout(model(2, 20), 20)).toEqual({ detail: 'full', maxAgentsPerProject: Infinity, maxProjects: Infinity, feedLines: 9 });
  });

  it('collapses agents to one row, then cuts them, keeping the frame below the height', () => {
    expect(computeDashboardLayout(model(6, 5), 16).detail).toBe('compact');
    const cut = computeDashboardLayout(model(30, 5), 16);
    expect(cut.detail).toBe('compact');
    // title 1 + project 1 + agents + "+N more" 1 + gap 1 + feed (title + 2) 3 ≤ 15.
    expect(cut.maxAgentsPerProject).toBe(8);
    expect(cut.feedLines).toBe(2);
  });

  it('counts only the rows an agent has: a master with no task or activity takes one', () => {
    const master: DashboardAgent = { key: 'p/master', agent_id: 'master', role: 'master', task_ref: null, state: 'running', phase: null, activity: null, attention: null };
    const p = { ...projectWith(0), agents: [master] };
    // title 1 + project 1 + master 1 + gap 1 = 4; feed title 1; 10 - 1 - 4 - 1 = 4 entries.
    expect(computeDashboardLayout({ projects: [p], feed: Array.from({ length: 9 }, (_, i) => entry(`e${i}`, null, i)), notice: null }, 10))
      .toMatchObject({ detail: 'full', feedLines: 4 });
  });

  it('cuts other projects, keeping the current one first, when even headers do not fit', () => {
    const many: DashboardModel = { projects: Array.from({ length: 20 }, (_, i) => projectWith(2, `p${i}`)), feed: [], notice: null };
    const layout = computeDashboardLayout(many, 12);
    // title 1 + projects × (header 1 + "+2 more" 1) + "+N more projects" 1 + gap 1 + feed (title + "(none)") 2 ≤ 11.
    expect(layout).toEqual({ detail: 'compact', maxAgentsPerProject: 0, maxProjects: 3, feedLines: 0 });
  });
});

describe('agent rows', () => {
  const base: DashboardAgent = { key: 'p/w', agent_id: 'w', role: 'worker', task_ref: null, state: 'running', phase: null, activity: null, attention: null };

  it('does not repeat the state the identity row already shows', () => {
    expect(agentTaskLine(base)).toBe('');
    expect(agentLines(base, 'full')).toBe(1);
    expect(agentTaskLine({ ...base, task_ref: 'plan/t', phase: 'implement' })).toBe('plan/t · implement');
  });

  it('keeps the state on the task line when a badge replaces it, and counts the attention line', () => {
    const asking = { ...base, task_ref: 'plan/t', attention: { kind: 'question' as const, detail: 'ok?' } };
    expect(agentTaskLine(asking)).toBe('plan/t · running');
    expect(agentLines(asking, 'full')).toBe(3);
    expect(agentLines(asking, 'compact')).toBe(1);
  });

  it('has an activity line only when there is activity', () => {
    expect(agentLines({ ...base, task_ref: 'plan/t' }, 'full')).toBe(2);
    expect(agentLines({ ...base, task_ref: 'plan/t', activity: 'Running npm test' }, 'full')).toBe(3);
  });
});
