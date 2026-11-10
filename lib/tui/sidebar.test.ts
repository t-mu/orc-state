import { describe, expect, it } from 'vitest';
import {
  agentRowParts, buildSidebarModel, computeSidebarLayout, fitRow, formatElapsed, projectState, sidebarRowTarget,
  type SidebarAgent, type SidebarModel,
} from './sidebar.ts';
import type { TuiProjectView, TuiStatus } from './status.ts';

const NOW = Date.parse('2026-11-10T12:00:00Z');

function status(slots: { id: string; role?: string; phase?: string | null; startedAt?: string | null; age?: number; activity?: string; attention?: 'question' | 'stalled'; claimed?: boolean }[], scouts: TuiStatus['scouts'] = []): TuiStatus {
  return {
    worker_capacity: {
      configured_slots: 3, used_slots: slots.length, available_slots: 0, warming_slots: 0, unavailable_slots: 0,
      provider: 'claude', dispatch_ready_count: 0, waiting_for_capacity: 0,
      slots: slots.map(slot => ({
        agent_id: slot.id, role: slot.role ?? 'worker', provider: null, model: null, status: 'running', session_handle: null,
        slot_state: slot.claimed === false ? 'idle' : 'busy', active_run_id: null, active_task_ref: null,
        last_status_change_at: null, last_heartbeat_at: null,
        attention: slot.attention ? { kind: slot.attention, run_id: `r-${slot.id}`, since: null, detail: 'Which\n schema?', request_id: null } : null,
      })),
    },
    scouts,
    tasks: { counts: {}, total: 0 },
    claims: {
      active: slots.filter(slot => slot.claimed !== false).map(slot => ({
        run_id: `r-${slot.id}`, task_ref: `plan/${slot.id}`, agent_id: slot.id, state: 'in_progress',
        age_seconds: slot.age ?? null, idle_seconds: null, activity_seconds: null, heartbeat_seconds: null,
        current_phase: slot.phase ?? null, started_at: slot.startedAt ?? null,
        current_activity: slot.activity ? { text: slot.activity } as never : null,
      })),
      total: 0, awaiting_run_started: 0, in_progress: 0, stalled: 0,
    },
    failures: { startup: [], lifecycle: [] },
    recentEvents: [],
    eventReadError: '',
  };
}

function view(id: string, connection: TuiProjectView['connection'], s: TuiStatus | null): TuiProjectView {
  return { project_id: id, name: id, target_repo_root: `/repo/${id}`, state_dir: `/state/${id}`, connection, error: null, status: s, stale: s != null && connection !== 'running' };
}

const options = (overrides: Partial<Parameters<typeof buildSidebarModel>[1]> = {}) => ({
  stateDir: '/state/a', activeProjectId: null, nowMs: NOW, registryError: null, ...overrides,
});

describe('formatElapsed', () => {
  it('shows minutes under an hour, hours and padded minutes above', () => {
    expect([0, 59, 60, 12 * 60 + 5, 3600, 3600 + 4 * 60, 26 * 3600].map(formatElapsed)).toEqual(['0m', '0m', '1m', '12m', '1h00', '1h04', '26h00']);
    expect(formatElapsed(-5)).toBe('0m');
  });
});

describe('buildSidebarModel', () => {
  it('lists the active project\'s workers and scouts, never its master, attention first', () => {
    const model = buildSidebarModel([view('a', 'running', status([
      { id: 'w1', phase: 'implement', startedAt: '2026-11-10T10:56:00Z', activity: 'Running\n tests' },
      { id: 'boss', role: 'master' },
      { id: 'w2', attention: 'question', age: 125 },
      { id: 'w3', claimed: false },
    ], [{ agent_id: 's1', provider: null, model: null, status: 'running', session_handle: null, launched_at: '2026-11-10T11:30:00Z' }]))], options());

    expect(model.agents).toEqual<SidebarAgent[]>([
      { key: 'a/w2', agent_id: 'w2', role: 'worker', phase: 'in_progress', elapsed: '2m', detail: '? Which schema?', attention: 'question' },
      { key: 'a/w1', agent_id: 'w1', role: 'worker', phase: 'implement', elapsed: '1h04', detail: 'Running tests', attention: null },
      { key: 'a/w3', agent_id: 'w3', role: 'worker', phase: 'idle', elapsed: null, detail: null, attention: null },
      { key: 'a/s1', agent_id: 's1', role: 'scout', phase: 'running', elapsed: '30m', detail: 'scout', attention: null },
    ]);
  });

  it('picks the active project: the chosen one, else the started-for one, else the first', () => {
    const views = [view('a', 'running', null), view('b', 'running', null)];
    expect(buildSidebarModel(views, options()).activeProjectId).toBe('a');
    expect(buildSidebarModel(views, options({ stateDir: '/state/b' })).activeProjectId).toBe('b');
    expect(buildSidebarModel(views, options({ activeProjectId: 'b' })).projects.map(p => p.active)).toEqual([false, true]);
    expect(buildSidebarModel(views, options({ activeProjectId: 'gone', stateDir: '/state/none' })).activeProjectId).toBe('a');
  });

  it('gives each project its state and attention count; the status box sums attention across projects', () => {
    const model = buildSidebarModel([
      view('a', 'running', status([{ id: 'w1' }])),
      view('b', 'unreachable', status([{ id: 'x', attention: 'question' }, { id: 'y', attention: 'stalled' }])),
      view('c', 'incompatible', null),
    ], options());
    expect(model.projects.map(p => [p.project_id, p.state, p.attention])).toEqual([['a', 'running', 0], ['b', 'stale', 2], ['c', 'incompatible', 0]]);
    expect(model.status).toEqual({ coordinator: 'running', workers: { used: 1, total: 3 }, attention: 2 });
    expect(buildSidebarModel([view('c', 'stopped', null)], options()).status).toEqual({ coordinator: 'stopped', workers: null, attention: 0 });
  });

  it('says why nothing is shown', () => {
    expect(buildSidebarModel([], options()).notice).toBe('no registered projects');
    expect(buildSidebarModel([], options({ registryError: 'bad' })).notice).toBe('registry error: bad');
  });

  it('maps an unreachable coordinator to stale and keeps the others', () => {
    expect(['running', 'connecting', 'stopped', 'unreachable', 'incompatible'].map(c => projectState(c as TuiProjectView['connection'])))
      .toEqual(['running', 'connecting', 'stopped', 'stale', 'incompatible']);
  });
});

describe('rows', () => {
  it('fits a row to its width, cutting the left part first', () => {
    expect(fitRow('name', 'running', 15)).toEqual({ left: 'name', gap: '    ', right: 'running' });
    expect(fitRow('a-long-name', 'running', 12)).toEqual({ left: 'a-l…', gap: ' ', right: 'running' });
    expect(fitRow('name', 'incompatible', 8)).toEqual({ left: '', gap: '', right: 'incompa…' });
  });

  it('keeps the phase and elapsed time on an agent row, cutting the name', () => {
    const agent: SidebarAgent = { key: 'a/w', agent_id: 'wretched-cave-worker', role: 'worker', phase: 'implement', elapsed: '1h04', detail: null, attention: null };
    const parts = agentRowParts(agent, 30);
    expect(parts).toEqual({ name: 'wretched-cave-…', gap: ' ', tag: 'implement', elapsed: ' 1h04' });
    expect(Object.values(parts).join('').length).toBe(30);
    expect(agentRowParts({ ...agent, attention: 'no_progress' }, 30).tag).toBe('NO PROGRESS');
    expect(agentRowParts({ ...agent, elapsed: null }, 30).elapsed).toBe('');
    // Too narrow for both: the time goes first, then the phase is cut.
    expect(agentRowParts(agent, 6)).toEqual({ name: '', gap: '', tag: 'imple…', elapsed: '' });
  });
});

function model(projects: number, agents: { attention?: boolean }[], notice: string | null = null): SidebarModel {
  return {
    status: { coordinator: 'running', workers: null, attention: 0 },
    projects: Array.from({ length: projects }, (_, i) => ({
      project_id: `p${i}`, name: `p${i}`, state_dir: '', target_repo_root: '', connection: 'running', state: 'running', error: null, attention: 0, active: i === 0,
    })),
    activeProjectId: 'p0',
    agents: agents.map((agent, i) => ({
      key: `p0/w${i}`, agent_id: `w${i}`, role: 'worker', phase: 'x', elapsed: null, detail: null, attention: agent.attention ? 'question' : null,
    })),
    agentsStale: false,
    notice,
  };
}

/** Frame rows of `layout`: status box, projects box and agents box (as App draws them), plus the row kept free. */
function frameRows(m: SidebarModel, layout: ReturnType<typeof computeSidebarLayout>): number {
  const projects = Math.max(1, layout.projectCount) + (layout.projectCount < m.projects.length ? 1 : 0);
  const agents = m.agents.length === 0 ? 1 : 2 * layout.agents.length + (layout.agents.length < m.agents.length ? 1 : 0);
  return 2 + 2 + (m.notice ? 1 : 0) + 2 + projects + 2 + agents + 1;
}

describe('computeSidebarLayout', () => {
  it('shows everything without a terminal height or when it fits', () => {
    const m = model(3, [{}, {}]);
    expect(computeSidebarLayout(m, undefined)).toEqual({ projectStart: 0, projectCount: 3, agents: [0, 1] });
    expect(computeSidebarLayout(m, 40)).toEqual({ projectStart: 0, projectCount: 3, agents: [0, 1] });
  });

  it('gives the agents the remaining rows, cutting others but never one needing attention', () => {
    const m = model(2, [{ attention: true }, { attention: true }, {}, {}, {}, {}, {}, {}]);
    const layout = computeSidebarLayout(m, 20);
    expect(frameRows(m, layout)).toBeLessThanOrEqual(20);
    expect(layout.agents.slice(0, 2)).toEqual([0, 1]);
    expect(layout.agents.length).toBeLessThan(8);
    // Even with no room at all, the attention agents stay.
    expect(computeSidebarLayout(m, 8).agents).toEqual([0, 1]);
  });

  it('keeps the cursor in view: the other agents scroll, the projects box windows around its cursor', () => {
    const m = model(2, [{ attention: true }, {}, {}, {}, {}, {}, {}, {}]);
    const layout = computeSidebarLayout(m, 20, { project: 0, agent: 7 });
    expect(layout.agents[0]).toBe(0);
    expect(layout.agents).toContain(7);

    const many = model(12, [{ attention: true }]);
    const cut = computeSidebarLayout(many, 18, { project: 10, agent: 0 });
    expect(cut.projectCount).toBeLessThan(12);
    expect(cut.projectStart).toBeLessThanOrEqual(10);
    expect(cut.projectStart + cut.projectCount).toBeGreaterThan(10);
    expect(frameRows(many, cut)).toBeLessThanOrEqual(18);
    expect(cut.agents).toEqual([0]);
  });
});

describe('sidebarRowTarget', () => {
  it('maps frame rows to projects and agents (either agent row), and borders to nothing', () => {
    const m = model(2, [{}, {}], 'note');
    const layout = computeSidebarLayout(m, undefined);
    // 0 status top, 1-3 status, 4 bottom; 5 projects top, 6-7 projects, 8 bottom; 9 agents top, 10-13 agents, 14 bottom.
    const targets = Array.from({ length: 16 }, (_, y) => sidebarRowTarget(m, layout, y));
    expect(targets.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(targets.slice(6, 8)).toEqual([{ kind: 'project', index: 0 }, { kind: 'project', index: 1 }]);
    expect(targets.slice(8, 10)).toEqual([null, null]);
    expect(targets.slice(10, 14)).toEqual([
      { kind: 'agent', index: 0 }, { kind: 'agent', index: 0 }, { kind: 'agent', index: 1 }, { kind: 'agent', index: 1 },
    ]);
    expect(targets.slice(14)).toEqual([null, null]);
  });

  it('accounts for a cut projects list and windowed agents', () => {
    const m = model(12, [{ attention: true }, {}, {}, {}, {}, {}, {}, {}]);
    const layout = computeSidebarLayout(m, 22, { project: 11, agent: 7 });
    const projectsTop = 4;
    expect(sidebarRowTarget(m, layout, projectsTop + 1)).toEqual({ kind: 'project', index: layout.projectStart });
    const agentsTop = projectsTop + 2 + layout.projectCount + 1;
    expect(sidebarRowTarget(m, layout, agentsTop + 1)).toEqual({ kind: 'agent', index: 0 });
    expect(sidebarRowTarget(m, layout, agentsTop + 3)).toEqual({ kind: 'agent', index: layout.agents[1] });
  });
});
