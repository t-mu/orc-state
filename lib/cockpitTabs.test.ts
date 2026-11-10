import { describe, expect, it } from 'vitest';
import {
  EMPTY_COCKPIT_STATE, closeTab, closedTabs, cycleProject, cycleTab, nextAttention, openAgent, parseTabs, reconcileTabs,
  selectProject, selectTab, serializeTabs, showableAttention, shownTab, type CockpitTabState, type TabTransition,
} from './cockpitTabs.ts';

/** p-1 active, showing w2 of [w1, w2, w3]; p-2 on its master tab with one agent tab. */
const STATE: CockpitTabState = {
  activeProject: 'p-1',
  projects: [
    { projectId: 'p-1', tabs: ['w1', 'w2', 'w3'], active: 'w2' },
    { projectId: 'p-2', tabs: ['x1'], active: null },
  ],
};

function okState(result: TabTransition): CockpitTabState {
  expect(result.ok, result.message).toBe(true);
  return result.state;
}

function expectRefused(result: TabTransition, before: CockpitTabState, message: RegExp) {
  expect(result.ok).toBe(false);
  expect(result.state).toBe(before);
  expect(result.message).toMatch(message);
}

describe('selectProject / cycleProject', () => {
  it('activates a project with the tabs and active tab it left', () => {
    const state = okState(selectProject(STATE, 'p-2'));
    expect(state.activeProject).toBe('p-2');
    expect(state.projects).toEqual(STATE.projects);
    expect(shownTab(okState(selectProject(state, 'p-1')))).toEqual({ projectId: 'p-1', agentId: 'w2' });
  });

  it('refuses an unknown project', () => {
    expectRefused(selectProject(STATE, 'nope'), STATE, /Unknown project 'nope'/);
  });

  it('cycles projects both ways, wrapping around', () => {
    expect(okState(cycleProject(STATE, 1)).activeProject).toBe('p-2');
    expect(okState(cycleProject(STATE, -1)).activeProject).toBe('p-2');
    expect(okState(cycleProject(okState(cycleProject(STATE, 1)), 1)).activeProject).toBe('p-1');
  });

  it('has no project to switch to in an empty cockpit', () => {
    expectRefused(cycleProject(EMPTY_COCKPIT_STATE, 1), EMPTY_COCKPIT_STATE, /No project is open/);
    expectRefused(selectProject(EMPTY_COCKPIT_STATE, 'p-1'), EMPTY_COCKPIT_STATE, /Unknown project/);
  });
});

describe('openAgent', () => {
  it('opens a new tab after the others and activates it and its project', () => {
    const result = openAgent(STATE, 'p-2', 'x2');
    expect(result.message).toBe('Opened x2 in a new tab.');
    const state = okState(result);
    expect(state.activeProject).toBe('p-2');
    expect(state.projects[1]).toEqual({ projectId: 'p-2', tabs: ['x1', 'x2'], active: 'x2' });
    expect(state.projects[0]).toEqual(STATE.projects[0]);
  });

  it('activates an open tab instead of opening another', () => {
    const result = openAgent(STATE, 'p-1', 'w1');
    expect(result.message).toBe("Switched to w1's tab.");
    expect(okState(result).projects[0]).toEqual({ projectId: 'p-1', tabs: ['w1', 'w2', 'w3'], active: 'w1' });
  });

  it('adds a project the cockpit has no tabs for, after the others', () => {
    const state = okState(openAgent(STATE, 'p-3', 'z1'));
    expect(state.activeProject).toBe('p-3');
    expect(state.projects.map((project) => project.projectId)).toEqual(['p-1', 'p-2', 'p-3']);
    expect(state.projects[2]).toEqual({ projectId: 'p-3', tabs: ['z1'], active: 'z1' });
  });

  it('opens the first tab of a fresh cockpit', () => {
    expect(okState(openAgent(EMPTY_COCKPIT_STATE, 'p-1', 'w1'))).toEqual({
      activeProject: 'p-1', projects: [{ projectId: 'p-1', tabs: ['w1'], active: 'w1' }],
    });
  });

  it('refuses an empty project or agent id', () => {
    expectRefused(openAgent(STATE, '', 'w1'), STATE, /needs a project and an agent id/);
    expectRefused(openAgent(STATE, 'p-1', ''), STATE, /needs a project and an agent id/);
  });
});

describe('selectTab / cycleTab', () => {
  it('selects by position, 1 being the master tab', () => {
    expect(shownTab(okState(selectTab(STATE, 1)))).toEqual({ projectId: 'p-1', agentId: null });
    expect(shownTab(okState(selectTab(STATE, 2)))).toEqual({ projectId: 'p-1', agentId: 'w1' });
    expect(shownTab(okState(selectTab(STATE, 4)))).toEqual({ projectId: 'p-1', agentId: 'w3' });
  });

  it('refuses a position with no tab', () => {
    expectRefused(selectTab(STATE, 5), STATE, /No tab 5: the project has 4 tabs/);
    expectRefused(selectTab(STATE, 0), STATE, /No tab 0/);
    const single = okState(selectProject({ activeProject: 'p-1', projects: [{ projectId: 'p-1', tabs: [], active: null }] }, 'p-1'));
    expectRefused(selectTab(single, 2), single, /the project has 1 tab\./);
  });

  it('selects by id: master or an open agent tab, never an unknown agent', () => {
    expect(shownTab(okState(selectTab(STATE, 'master')))?.agentId).toBeNull();
    expect(shownTab(okState(selectTab(STATE, 'w3')))?.agentId).toBe('w3');
    expectRefused(selectTab(STATE, 'x1'), STATE, /No tab for agent 'x1'/);
    expectRefused(selectTab(STATE, 'ghost'), STATE, /No tab for agent 'ghost'/);
  });

  it('cycles the active project\'s tabs both ways, wrapping around through the master tab', () => {
    expect(shownTab(okState(cycleTab(STATE, 1)))?.agentId).toBe('w3');
    expect(shownTab(okState(cycleTab(STATE, -1)))?.agentId).toBe('w1');
    const last = okState(selectTab(STATE, 'w3'));
    expect(shownTab(okState(cycleTab(last, 1)))?.agentId).toBeNull();
    const master = okState(selectTab(STATE, 'master'));
    expect(shownTab(okState(cycleTab(master, -1)))?.agentId).toBe('w3');
  });

  it('stays on the master tab of a project with no agent tabs', () => {
    const state = okState(selectProject(STATE, 'p-2'));
    const lone = okState(closeTab(state, 'x1'));
    expect(shownTab(okState(cycleTab(lone, 1)))).toEqual({ projectId: 'p-2', agentId: null });
  });

  it('needs an active project', () => {
    expectRefused(selectTab(EMPTY_COCKPIT_STATE, 1), EMPTY_COCKPIT_STATE, /No project is open/);
    expectRefused(cycleTab(EMPTY_COCKPIT_STATE, 1), EMPTY_COCKPIT_STATE, /No project is open/);
  });
});

describe('closeTab', () => {
  it('never closes the master tab', () => {
    const master = okState(selectTab(STATE, 'master'));
    expectRefused(closeTab(master), master, /The master tab stays open/);
    expectRefused(closeTab(STATE, 'master'), STATE, /The master tab stays open/);
  });

  it('closing the active tab activates the tab that takes its place, else the one before it', () => {
    const middle = okState(closeTab(STATE));
    expect(middle.projects[0]).toEqual({ projectId: 'p-1', tabs: ['w1', 'w3'], active: 'w3' });
    const last = okState(closeTab(okState(selectTab(STATE, 'w3'))));
    expect(last.projects[0]).toEqual({ projectId: 'p-1', tabs: ['w1', 'w2'], active: 'w2' });
    const only = okState(closeTab(okState(openAgent({ activeProject: 'p-9', projects: [] }, 'p-9', 'solo'))));
    expect(only.projects[0]).toEqual({ projectId: 'p-9', tabs: [], active: null });
  });

  it('closing another tab keeps the active one', () => {
    const result = closeTab(STATE, 'w1');
    expect(result.message).toBe("Closed w1's tab; w2's tab is active.");
    expect(okState(result).projects[0]).toEqual({ projectId: 'p-1', tabs: ['w2', 'w3'], active: 'w2' });
  });

  it('refuses an agent with no tab in the active project', () => {
    expectRefused(closeTab(STATE, 'x1'), STATE, /No tab for agent 'x1'/);
    expectRefused(closeTab(EMPTY_COCKPIT_STATE), EMPTY_COCKPIT_STATE, /No project is open/);
  });

  it('reports the closed tab so only its window closes', () => {
    expect(closedTabs(STATE, okState(closeTab(STATE)))).toEqual([{ projectId: 'p-1', agentId: 'w2' }]);
    expect(closedTabs(STATE, okState(selectProject(STATE, 'p-2')))).toEqual([]);
  });
});

describe('nextAttention', () => {
  const waiting = [
    { projectId: 'p-2', agentId: 'x9' },
    { projectId: 'p-1', agentId: 'w3' },
    { projectId: 'p-2', agentId: 'master', master: true },
  ];

  it('changes nothing when no agent is waiting', () => {
    const result = nextAttention(STATE, []);
    expect(result).toEqual({ ok: true, state: STATE, message: 'No agent needs attention.' });
  });

  it('starts with the first waiting agent, switching project and opening its tab', () => {
    const state = okState(nextAttention(STATE, waiting));
    expect(state.activeProject).toBe('p-2');
    expect(state.projects[1]).toEqual({ projectId: 'p-2', tabs: ['x1', 'x9'], active: 'x9' });
  });

  it('moves on from the shown waiting agent, to an open tab, then to a master, then wraps around', () => {
    const first = okState(nextAttention(STATE, waiting));
    const second = okState(nextAttention(first, waiting));
    expect(shownTab(second)).toEqual({ projectId: 'p-1', agentId: 'w3' });
    expect(second.projects[0].tabs).toEqual(['w1', 'w2', 'w3']);
    const third = okState(nextAttention(second, waiting));
    expect(shownTab(third)).toEqual({ projectId: 'p-2', agentId: null });
    expect(shownTab(okState(nextAttention(third, waiting)))).toEqual({ projectId: 'p-2', agentId: 'x9' });
  });

  it('opens a waiting agent in a project the cockpit has no tabs for', () => {
    const state = okState(nextAttention(EMPTY_COCKPIT_STATE, [{ projectId: 'p-5', agentId: 'q1' }]));
    expect(state).toEqual({ activeProject: 'p-5', projects: [{ projectId: 'p-5', tabs: ['q1'], active: 'q1' }] });
  });
});

describe('showableAttention', () => {
  it('keeps agents, and masters only of projects with a master tab open', () => {
    const open = [{ projectId: 'p-1', agentId: null }, { projectId: 'p-3', agentId: 'z1' }];
    expect(showableAttention([
      { projectId: 'p-1', agentId: 'master', master: true },
      { projectId: 'p-2', agentId: 'master', master: true },
      { projectId: 'p-3', agentId: 'master', master: true },
      { projectId: 'p-4', agentId: 'q1' },
    ], open)).toEqual([{ projectId: 'p-1', agentId: 'master', master: true }, { projectId: 'p-4', agentId: 'q1' }]);
  });
});

describe('reconcileTabs', () => {
  const windows = [
    { projectId: 'p-1', agentId: null },
    { projectId: 'p-1', agentId: 'w1' },
    { projectId: 'p-1', agentId: 'w2' },
    { projectId: 'p-1', agentId: 'w3' },
    { projectId: 'p-2', agentId: null },
    { projectId: 'p-2', agentId: 'x1' },
  ];

  it('keeps a state that matches the windows', () => {
    expect(reconcileTabs(STATE, windows, { projectId: 'p-1', agentId: 'w2' })).toEqual(STATE);
  });

  it('rebuilds a missing state from the windows, in window order, showing the current window', () => {
    expect(reconcileTabs(EMPTY_COCKPIT_STATE, windows, { projectId: 'p-2', agentId: 'x1' })).toEqual({
      activeProject: 'p-2',
      projects: [
        { projectId: 'p-1', tabs: ['w1', 'w2', 'w3'], active: null },
        { projectId: 'p-2', tabs: ['x1'], active: 'x1' },
      ],
    });
    expect(reconcileTabs(EMPTY_COCKPIT_STATE, [], null)).toEqual(EMPTY_COCKPIT_STATE);
  });

  it('drops tabs whose window closed, falling back to the master tab, and adds windows it does not list', () => {
    const open = windows.filter((tab) => tab.agentId !== 'w2').concat({ projectId: 'p-1', agentId: 'w4' });
    expect(reconcileTabs(STATE, open, null).projects[0]).toEqual({ projectId: 'p-1', tabs: ['w1', 'w3', 'w4'], active: null });
  });

  it('drops a project with no window left, moving to the first remaining one', () => {
    const open = windows.filter((tab) => tab.projectId !== 'p-1');
    expect(reconcileTabs(STATE, open, null)).toEqual({ activeProject: 'p-2', projects: [STATE.projects[1]] });
  });

  it('follows a window changed by a click or a plain tmux key', () => {
    const state = reconcileTabs(STATE, windows, { projectId: 'p-2', agentId: null });
    expect(state.activeProject).toBe('p-2');
    expect(state.projects[0].active).toBe('w2');
  });

  it('ignores a current window that is no tab', () => {
    expect(reconcileTabs(STATE, windows, { projectId: 'p-7', agentId: null })).toEqual(STATE);
  });

  it('keeps a project that has only agent tabs (opened before its master tab)', () => {
    expect(reconcileTabs(EMPTY_COCKPIT_STATE, [{ projectId: 'p-3', agentId: 'z1' }], null)).toEqual({
      activeProject: 'p-3', projects: [{ projectId: 'p-3', tabs: ['z1'], active: null }],
    });
  });
});

describe('serializeTabs / parseTabs', () => {
  it('round-trips a state', () => {
    expect(parseTabs(serializeTabs(STATE))).toEqual(STATE);
    expect(parseTabs(serializeTabs(EMPTY_COCKPIT_STATE))).toEqual(EMPTY_COCKPIT_STATE);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not JSON', '{"v":1,'],
    ['another version', JSON.stringify({ ...STATE, v: 2 })],
    ['no version', JSON.stringify(STATE)],
    ['projects not a list', JSON.stringify({ v: 1, activeProject: null, projects: {} })],
    ['an active tab that is not open', JSON.stringify({ v: 1, activeProject: 'p', projects: [{ projectId: 'p', tabs: [], active: 'w1' }] })],
    ['a tab that is not a string', JSON.stringify({ v: 1, activeProject: 'p', projects: [{ projectId: 'p', tabs: [3], active: null }] })],
    ['a project without an id', JSON.stringify({ v: 1, activeProject: null, projects: [{ tabs: [], active: null }] })],
  ])('rejects a %s state', (_label, raw) => {
    expect(parseTabs(raw)).toBeNull();
  });
});
