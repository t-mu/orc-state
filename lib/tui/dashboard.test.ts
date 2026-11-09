import { describe, expect, it } from 'vitest';
import {
  buildDashboardModel, computeDashboardLayout, mergeFeed, notificationEntries,
  type DashboardFeedEntry, type DashboardModel, type DashboardProject,
} from './dashboard.ts';

function entry(key: string, ts: string | null, seq: number | null = null): DashboardFeedEntry {
  return { key, project: 'p', seq, ts, event: 'run_finished', agent_id: null, task_ref: null, reason: null };
}

function projectWith(agents: number): DashboardProject {
  return {
    project_id: 'p', state_dir: '/state/p', name: 'p', current: true, connection: 'running', error: null, stale: false,
    agents: Array.from({ length: agents }, (_, i) => ({
      key: `p/a${i}`, agent_id: `a${i}`, role: 'worker', task_ref: null, state: 'in_progress', phase: null, activity: null, attention: null,
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

describe('computeDashboardLayout', () => {
  it('shows everything without a terminal height', () => {
    expect(computeDashboardLayout(model(50, 20), undefined)).toEqual({ detail: 'full', maxAgentsPerProject: Infinity, feedLines: 20 });
  });

  it('uses full agent rows when they fit, giving the rest to the feed', () => {
    // title 1 + project 1 + 2 agents × 3 + gap 1 = 9; feed title 1; 20 - 1 - 9 - 1 = 9 entries.
    expect(computeDashboardLayout(model(2, 20), 20)).toEqual({ detail: 'full', maxAgentsPerProject: Infinity, feedLines: 9 });
  });

  it('collapses agents to one row, then cuts them, keeping the frame below the height', () => {
    expect(computeDashboardLayout(model(6, 5), 16).detail).toBe('compact');
    const cut = computeDashboardLayout(model(30, 5), 16);
    expect(cut.detail).toBe('compact');
    // title 1 + project 1 + agents + "+N more" 1 + gap 1 + feed (title + 2) 3 ≤ 15.
    expect(cut.maxAgentsPerProject).toBe(8);
    expect(cut.feedLines).toBe(2);
  });
});
