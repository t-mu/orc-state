import { describe, expect, it } from 'vitest';
import type { TuiProjectView, TuiStatus } from './status.ts';
import {
  NO_PROJECT_NOTICE, buildTabBarModel, layoutTabBar, tabAttention, tabBarClickTarget, tabBarRows, tabBarText, tabWidth,
  type TabBarState,
} from './tabBarModel.ts';

const state = (tabs: string[], active: string | null): TabBarState => ({
  activeProject: 'p-1',
  projects: [{ projectId: 'p-1', tabs, active }, { projectId: 'p-2', tabs: ['other'], active: 'other' }],
});

function view(projectId: string, slots: { agent_id: string; role?: string; kind?: 'question' | 'permission_prompt' | 'stalled' | 'no_progress' }[]): TuiProjectView {
  return {
    project_id: projectId, name: projectId, target_repo_root: '/repo', state_dir: `/state/${projectId}`, connection: 'running', error: null, stale: false,
    status: {
      worker_capacity: {
        slots: slots.map(slot => ({
          agent_id: slot.agent_id, role: slot.role ?? 'worker',
          attention: slot.kind ? { kind: slot.kind, run_id: null, since: null, detail: null, request_id: null } : null,
        })),
      },
    } as unknown as TuiStatus,
  };
}

describe('buildTabBarModel', () => {
  it('lists the master tab first, then the agent tabs in opening order, numbered as the tab keys select them', () => {
    const model = buildTabBarModel(state(['w1', 'w2'], 'w2'));
    expect(model.notice).toBeNull();
    expect(model.tabs.map(tab => [tab.number, tab.label, tab.active, tab.closable])).toEqual([
      [1, 'master', false, false],
      [2, 'w1', false, true],
      [3, 'w2', true, true],
    ]);
    expect(buildTabBarModel(state([], null)).tabs.map(tab => tab.active)).toEqual([true]);
  });

  it('badges the agent tabs whose agent needs attention, from the active project only and never the master', () => {
    const views = [
      view('p-1', [{ agent_id: 'w1', kind: 'question' }, { agent_id: 'w2' }, { agent_id: 'master', role: 'master', kind: 'question' }]),
      view('p-2', [{ agent_id: 'w2', kind: 'stalled' }]),
    ];
    const attention = tabAttention(views, 'p-1');
    expect([...attention]).toEqual([['w1', 'question']]);
    expect(buildTabBarModel(state(['w1', 'w2'], null), attention).tabs.map(tab => tab.attention)).toEqual([null, 'question', null]);
    expect(tabAttention(views, 'p-3').size).toBe(0);
  });

  it('says when no project is open', () => {
    expect(buildTabBarModel({ activeProject: null, projects: [] })).toEqual({ tabs: [], notice: NO_PROJECT_NOTICE });
  });
});

describe('tab bar rows', () => {
  it('draws bordered tabs, the active one open to the slot, agent tabs with a close marker, over a rule', () => {
    const model = buildTabBarModel(state(['w1'], 'w1'), new Map([['w1', 'question']]));
    const layout = layoutTabBar(model, 40);
    expect(tabBarText(tabBarRows(model, layout, 40))).toEqual([
      '╭──────────╮╭─────────────────╮',
      '│ 1 master ││ 2 w1 QUESTION × │',
      `┴──────────┴╯                 ╰${'─'.repeat(9)}`,
    ]);
  });

  it('shows a notice in the middle row, and an action error in the bottom row', () => {
    const none = buildTabBarModel({ activeProject: null, projects: [] });
    expect(tabBarText(tabBarRows(none, layoutTabBar(none, 20), 20))).toEqual(['', 'No project is open;…', '─'.repeat(20)]);
    const model = buildTabBarModel(state([], null));
    expect(tabBarText(tabBarRows(model, layoutTabBar(model, 30), 30, 'tmux select-pane failed'))[2]).toBe('tmux select-pane failed');
  });
});

describe('layoutTabBar overflow', () => {
  const many = Array.from({ length: 12 }, (_, index) => `worker-${String(index + 1).padStart(2, '0')}`);

  it('shows every tab when they fit 200 columns', () => {
    const model = buildTabBarModel(state(many.slice(0, 8), 'worker-07'));
    const layout = layoutTabBar(model, 200);
    expect(layout.cells.map(cell => cell.index)).toEqual(model.tabs.map((_, index) => index));
    expect([layout.hiddenLeft, layout.hiddenRight, layout.leftMarker, layout.rightMarker]).toEqual([0, 0, '', '']);
    expect(tabBarText(tabBarRows(model, layout, 200)).every(row => row.length <= 200)).toBe(true);
  });

  it.each([40, 200])('keeps the active tab shown at %i columns, with markers counting the hidden tabs', (columns) => {
    const tabs = columns === 40 ? many : [...many, ...many.map(id => `${id}-b`)];
    for (const active of [null, tabs[0], tabs[6], tabs.at(-1)!]) {
      const model = buildTabBarModel(state(tabs, active));
      const layout = layoutTabBar(model, columns);
      expect(layout.hiddenLeft + layout.hiddenRight).toBeGreaterThan(0);
      const activeIndex = model.tabs.findIndex(tab => tab.active);
      expect(layout.cells.some(cell => cell.index === activeIndex)).toBe(true);
      expect(layout.hiddenLeft + layout.cells.length + layout.hiddenRight).toBe(model.tabs.length);
      expect(layout.leftMarker).toBe(layout.hiddenLeft > 0 ? `‹ ${layout.hiddenLeft} ` : '');
      expect(layout.rightMarker).toBe(layout.hiddenRight > 0 ? ` ${layout.hiddenRight} ›` : '');
      const rows = tabBarText(tabBarRows(model, layout, columns));
      expect(rows.every(row => row.length <= columns)).toBe(true);
      expect(rows[1]).toContain(model.tabs[activeIndex].label);
    }
    const middle = layoutTabBar(buildTabBarModel(state(many, 'worker-07')), 40);
    expect(tabBarText(tabBarRows(buildTabBarModel(state(many, 'worker-07')), middle, 40))[1]).toMatch(/^‹ \d+ .* \d+ ›$/);
  });

  it('cuts the name of an active tab that does not fit even alone', () => {
    const model = buildTabBarModel(state(['a-very-long-agent-name-indeed'], 'a-very-long-agent-name-indeed'), new Map([['a-very-long-agent-name-indeed', 'permission_prompt']]));
    expect(tabWidth(model.tabs[1])).toBeGreaterThan(30);
    const layout = layoutTabBar(model, 30);
    expect(layout.cells.map(cell => cell.index)).toEqual([1]);
    const rows = tabBarText(tabBarRows(model, layout, 30));
    expect(rows.every(row => row.length <= 30)).toBe(true);
    expect(rows[1]).toBe('‹ 1 │ 2 a-very… PERMISSION × │');
  });
});

describe('tabBarClickTarget', () => {
  const model = buildTabBarModel(state(['w1'], null));
  const layout = layoutTabBar(model, 40);
  const [master, w1] = layout.cells;

  it('selects the tab under the click, on any row of it', () => {
    expect(tabBarClickTarget(model, layout, master.x)).toEqual({ kind: 'select', tab: model.tabs[0] });
    expect(tabBarClickTarget(model, layout, w1.x + 2)).toEqual({ kind: 'select', tab: model.tabs[1] });
    expect(tabBarClickTarget(model, layout, w1.x + w1.width)).toBeNull();
  });

  it('closes an agent tab at its close marker; the master tab has none', () => {
    const middle = tabBarText(tabBarRows(model, layout, 40))[1];
    expect(middle[w1.closeX!]).toBe('×');
    expect(tabBarClickTarget(model, layout, w1.closeX!)).toEqual({ kind: 'close', tab: model.tabs[1] });
    expect(master.closeX).toBeNull();
    expect(middle.slice(master.x, master.x + master.width)).not.toContain('×');
    for (let x = master.x; x < master.x + master.width; x += 1) expect(tabBarClickTarget(model, layout, x)?.kind).toBe('select');
  });

  it('does nothing over a notice', () => {
    const none = buildTabBarModel({ activeProject: null, projects: [] });
    expect(tabBarClickTarget(none, layoutTabBar(none, 40), 3)).toBeNull();
  });
});
