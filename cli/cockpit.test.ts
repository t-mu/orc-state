import { describe, expect, it, vi } from 'vitest';
import type { ProjectListEntry } from '../client.ts';
import type { AgentTabResolver, CockpitActionResult, StoppedProjectResolver } from '../adapters/tmuxCockpit.ts';
import type { CockpitTabState, OpenTab, TabTransition } from '../lib/cockpitTabs.ts';
import { NOT_IN_COCKPIT, parseCockpitArgs, runCockpit, throttle, tabProject, waitingAgents, type CockpitDeps } from './cockpit.ts';

const STATE: CockpitTabState = {
  activeProject: 'p-1',
  projects: [
    { projectId: 'p-1', tabs: ['w1'], active: 'w1' },
    { projectId: 'p-2', tabs: [], active: null },
  ],
};

const entry = (id: string, extra: Partial<ProjectListEntry> = {}): ProjectListEntry => ({
  id, name: `name-${id}`, target_repo_root: `/work/${id}`, state_dir: `/state/${id}`, repo_present: true, control_socket: null, coordinator_running: false, ...extra,
});

/** Fake deps: `apply` runs the transition on `state` and records it, as applyCockpitTransition does without tmux. */
function fakeDeps(overrides: Partial<CockpitDeps> = {}, open: OpenTab[] = [{ projectId: 'p-1', agentId: null }, { projectId: 'p-1', agentId: 'w1' }, { projectId: 'p-2', agentId: null }]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const messages: [string, string][] = [];
  let state = STATE;
  let resolver: AgentTabResolver | null = null;
  let stopped: StoppedProjectResolver | null = null;
  const deps: CockpitDeps = {
    inside: () => true,
    running: () => true,
    apply: vi.fn((transition: (s: CockpitTabState, o: OpenTab[]) => TabTransition, resolve?: AgentTabResolver, resolveStopped?: StoppedProjectResolver): CockpitActionResult => {
      resolver = resolve ?? null;
      stopped = resolveStopped ?? null;
      const result = transition(state, open);
      if (result.ok) state = result.state;
      return { ...result, opened: false };
    }),
    read: () => state,
    projects: () => [entry('p-1'), entry('p-2')],
    waiting: () => Promise.resolve([]),
    message: (client, text) => messages.push([client, text]),
    openExplorer: vi.fn(() => 'opened' as const),
    watcher: () => { throw new Error('the explorer is not run in these tests'); },
    bar: () => ({ state, slotMissing: false }),
    refresh: () => {},
    changes: () => () => {},
    focusSlot: () => {},
    orc: ['/node', '/orc.js'],
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
    ...overrides,
  };
  return { deps, lines, errors, messages, state: () => state, resolver: () => resolver, stopped: () => stopped };
}

describe('parseCockpitArgs', () => {
  it.each([
    [['project', 'p-2'], { action: 'project', target: 'p-2' }],
    [['project', 'next'], { action: 'project', target: 'next' }],
    [['open', 'w1'], { action: 'open', agentId: 'w1', projectId: null }],
    [['open', 'w1', 'p-2'], { action: 'open', agentId: 'w1', projectId: 'p-2' }],
    [['tab', '3'], { action: 'tab', tab: 3 }],
    [['tab', 'master'], { action: 'tab', tab: 'master' }],
    [['tab', 'w1'], { action: 'tab', tab: 'w1' }],
    [['next'], { action: 'next' }],
    [['prev'], { action: 'prev' }],
    [['close'], { action: 'close', agentId: null }],
    [['close', 'w1'], { action: 'close', agentId: 'w1' }],
    [['attention'], { action: 'attention' }],
    [['tasks'], { action: 'tasks', close: false }],
    [['tasks', 'close'], { action: 'tasks', close: true }],
    [['explorer', 'p-1'], { action: 'explorer', projectId: 'p-1' }],
    [['state'], { action: 'state' }],
    [['bar'], { action: 'bar' }],
  ])('parses %j', (argv, command) => {
    expect(parseCockpitArgs(argv)).toEqual({ command, client: null });
  });

  it('takes the client a key binding passes', () => {
    expect(parseCockpitArgs(['tab', '1', '--client=/dev/pts/3'])).toEqual({ command: { action: 'tab', tab: 1 }, client: '/dev/pts/3' });
  });

  it.each([
    [[], 'missing action'],
    [['fly'], "unknown action 'fly'"],
    [['project'], 'project needs a project id, next or prev'],
    [['open'], 'open needs an agent id'],
    [['tab'], 'tab needs a tab number, master or an agent id'],
    [['next', 'x'], "too many arguments for 'next'"],
    [['open', 'a', 'b', 'c'], "too many arguments for 'open'"],
    [['tab', '1', '--force'], "unknown option '--force'"],
    [['tasks', 'open'], "tasks takes only 'close', not 'open'"],
    [['explorer'], 'explorer needs a project id'],
  ])('rejects %j', (argv, error) => {
    expect(parseCockpitArgs(argv)).toEqual({ error });
  });
});

describe('runCockpit', () => {
  it('exits 1 with a message outside the cockpit, touching nothing', async () => {
    const fake = fakeDeps({ inside: () => false });
    expect(await runCockpit(['next'], fake.deps)).toBe(1);
    expect(fake.errors).toEqual([NOT_IN_COCKPIT]);
    expect(fake.deps.apply).not.toHaveBeenCalled();
    const stopped = fakeDeps({ running: () => false });
    expect(await runCockpit(['next', '--client=/dev/pts/1'], stopped.deps)).toBe(1);
    expect(stopped.errors).toEqual([NOT_IN_COCKPIT]);
  });

  it('prints usage for bad arguments', async () => {
    const fake = fakeDeps();
    expect(await runCockpit(['bogus'], fake.deps)).toBe(1);
    expect(fake.errors[0]).toContain("unknown action 'bogus'");
    expect(fake.errors[0]).toContain('Usage: orc cockpit');
  });

  it('applies a transition and prints what happened', async () => {
    const fake = fakeDeps();
    expect(await runCockpit(['tab', '1'], fake.deps)).toBe(0);
    expect(fake.lines).toEqual(['Switched to the master tab.']);
    expect(fake.state().projects[0].active).toBeNull();
    expect(await runCockpit(['project', 'next'], fake.deps)).toBe(0);
    expect(fake.state().activeProject).toBe('p-2');
  });

  it('shows the task explorer for the active project, and says so when it already is', async () => {
    const opened = fakeDeps({ openExplorer: vi.fn(() => 'opened' as const) });
    expect(await runCockpit(['tasks'], opened.deps)).toBe(0);
    expect(opened.deps.openExplorer).toHaveBeenCalledWith('p-1');
    expect(opened.lines).toEqual(['Opened the task explorer.']);
    const shown = fakeDeps({ openExplorer: vi.fn(() => 'switched' as const) });
    expect(await runCockpit(['tasks'], shown.deps)).toBe(0);
    expect(shown.lines).toEqual(['The task explorer is already shown.']);
  });

  it('refuses to show the task explorer when no project is open', async () => {
    const fake = fakeDeps({ read: () => ({ activeProject: null, projects: [] }) });
    expect(await runCockpit(['tasks'], fake.deps)).toBe(1);
    expect(fake.errors).toEqual(['No project is open in the cockpit; run orc start-session in one.']);
    expect(fake.deps.openExplorer).not.toHaveBeenCalled();
  });

  it('tasks close puts the active tab back through a transition, not the explorer opener', async () => {
    const fake = fakeDeps();
    expect(await runCockpit(['tasks', 'close'], fake.deps)).toBe(0);
    expect(fake.deps.apply).toHaveBeenCalledTimes(1);
    expect(fake.deps.openExplorer).not.toHaveBeenCalled();
    expect(fake.lines).toEqual(['Closed the task explorer.']);
  });

  it('exits 1 for a refused transition from a shell', async () => {
    const fake = fakeDeps();
    expect(await runCockpit(['close', 'master'], fake.deps)).toBe(1);
    expect(fake.errors).toEqual(['The master tab stays open; close agent tabs only.']);
  });

  it('reports to the key\'s client and exits 0, even when refused, so tmux shows only the message', async () => {
    const fake = fakeDeps();
    expect(await runCockpit(['tab', '1', '--client=/dev/pts/3'], fake.deps)).toBe(0);
    expect(await runCockpit(['close', '--client=/dev/pts/3'], fake.deps)).toBe(0);
    expect(fake.messages).toEqual([['/dev/pts/3', 'Switched to the master tab.'], ['/dev/pts/3', 'The master tab stays open; close agent tabs only.']]);
    expect(fake.lines).toEqual([]);
    expect(fake.errors).toEqual([]);
  });

  it('reports a failed action instead of throwing', async () => {
    const fake = fakeDeps({ apply: () => { throw new Error('tmux list-windows failed: boom'); } });
    expect(await runCockpit(['next'], fake.deps)).toBe(1);
    expect(fake.errors).toEqual(['orc cockpit: tmux list-windows failed: boom']);
  });

  it('opens an agent in the active project by default, resolving its tab through the project list', async () => {
    const fake = fakeDeps();
    expect(await runCockpit(['open', 'w2'], fake.deps)).toBe(0);
    expect(fake.state().projects[0]).toEqual({ projectId: 'p-1', tabs: ['w1', 'w2'], active: 'w2' });
    expect(fake.resolver()!('p-1', 'w2')).toMatchObject({
      projectId: 'p-1', projectName: 'name-p-1', root: '/work/p-1', command: ['/node', '/orc.js', 'terminal', 'w2', '--write', '--project=p-1'],
    });
    expect(await runCockpit(['open', 'x1', 'p-2'], fake.deps)).toBe(0);
    expect(fake.state().activeProject).toBe('p-2');
  });

  it('shows a registered project the cockpit has no tab for, as stopped: its message pane names how to start it', async () => {
    const fake = fakeDeps({ projects: () => [entry('p-1'), entry('p-2'), entry('p-3')] });
    expect(await runCockpit(['project', 'p-3'], fake.deps)).toBe(0);
    expect(fake.state().activeProject).toBe('p-3');
    expect(fake.state().projects.at(-1)).toEqual({ projectId: 'p-3', tabs: [], active: null });
    expect(fake.stopped()!('p-3')).toEqual({ projectId: 'p-3', projectName: 'name-p-3', root: '/work/p-3' });
    expect(() => fake.stopped()!('nope')).toThrow("unknown project 'nope'");
  });

  it('cycles through the waiting agents for attention', async () => {
    const waiting = vi.fn(() => Promise.resolve([{ projectId: 'p-2', agentId: 'x5' }]));
    const fake = fakeDeps({ waiting });
    expect(await runCockpit(['attention'], fake.deps)).toBe(0);
    expect(waiting).toHaveBeenCalledWith(STATE, [entry('p-1'), entry('p-2')]);
    expect(fake.state().activeProject).toBe('p-2');
    expect(fake.lines).toEqual(['Opened x5 in a new tab.']);
    const none = fakeDeps();
    expect(await runCockpit(['attention'], none.deps)).toBe(0);
    expect(none.lines).toEqual(['No agent needs attention.']);
  });

  it('skips a waiting master whose project has no master tab, so attention never gets stuck on it', async () => {
    const waiting = () => Promise.resolve([{ projectId: 'p-9', agentId: 'master', master: true }, { projectId: 'p-2', agentId: 'x5' }]);
    const fake = fakeDeps({ waiting });
    expect(await runCockpit(['attention'], fake.deps)).toBe(0);
    expect(fake.lines).toEqual(['Opened x5 in a new tab.']);
    const onlyMaster = fakeDeps({ waiting: () => Promise.resolve([{ projectId: 'p-9', agentId: 'master', master: true }]) });
    expect(await runCockpit(['attention'], onlyMaster.deps)).toBe(0);
    expect(onlyMaster.lines).toEqual(['No agent needs attention.']);
  });

  it('prints the state as JSON without changing it', async () => {
    const fake = fakeDeps();
    expect(await runCockpit(['state'], fake.deps)).toBe(0);
    expect(JSON.parse(fake.lines[0])).toEqual(STATE);
    expect(fake.deps.apply).not.toHaveBeenCalled();
  });
});

describe('tabProject', () => {
  it('finds a registered project, or an unregistered state directory, and refuses anything else', () => {
    expect(tabProject('p-1', [entry('p-1')])).toEqual({ project_id: 'p-1', name: 'name-p-1', state_dir: '/state/p-1', target_repo_root: '/work/p-1' });
    expect(tabProject('unregistered:/s/my proj', [])).toMatchObject({ project_id: 'unregistered:/s/my proj', name: 'my proj', state_dir: '/s/my proj' });
    expect(() => tabProject('nope', [entry('p-1')])).toThrow("unknown project 'nope'");
  });
});

describe('waitingAgents', () => {
  it('skips projects whose coordinator is not running and those it cannot ask', async () => {
    const projects = [entry('p-1'), entry('p-2', { coordinator_running: true, state_dir: '/nonexistent/orc-state' })];
    expect(await waitingAgents(STATE, projects)).toEqual([]);
  });
});

describe('throttle', () => {
  it('runs at most once per interval, so a slot the bar cannot put back does not loop on its own change signal', () => {
    let clock = 0;
    let runs = 0;
    const refresh = throttle(() => { runs += 1; }, 5_000, () => clock);
    for (let i = 0; i < 50; i += 1) refresh();
    expect(runs).toBe(1);
    clock = 4_999;
    refresh();
    expect(runs).toBe(1);
    clock = 5_000;
    refresh();
    expect(runs).toBe(2);
  });
});
