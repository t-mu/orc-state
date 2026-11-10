import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmuxSocketPath } from './tmux.ts';
import {
  COCKPIT_SOCKET, DEFAULT_COCKPIT_KEYS, SIDEBAR_COLUMNS, TAB_BAR_ROWS, agentTabScript, cockpitAgentTab, cockpitAttachCommand, cockpitKeyOptions, cockpitKeysHint,
  cockpitRunShell, cockpitServerEnv, cockpitServerOptions, cockpitStoppedProject, sidebarPaneScript, focusSlotCommands, frameOf, frameResizeHook, frameSizeCommands, holdingFitCommands, insideCockpit,
  isTmuxKeyName, keeperPaneScript, messagePaneScript, paneTab, parseCockpitPanes, placeholderPaneScript, resolveCockpitKeys, masterPaneScript, slotCommands,
  startCommand, tabBarPaneScript, tabPaneOptions, terminalHasTrueColor, withCockpitLock, explorerPaneScript, type CockpitPane,
} from './tmuxCockpit.ts';

const ORC = ['/usr/bin/node', '/orc/cli/orc.js'];
/** The run-shell binding of `orc cockpit <action>`. */
const runShell = (action: string) => ['run-shell', `'/usr/bin/node' '/orc/cli/orc.js' 'cockpit' ${action.split(' ').map((part) => `'${part}'`).join(' ')} --client='#{client_name}'`];

const originalBin = process.env.ORC_TMUX_BIN;
afterEach(() => {
  if (originalBin == null) delete process.env.ORC_TMUX_BIN; else process.env.ORC_TMUX_BIN = originalBin;
});

const master = { agentId: 'master', socket: 'orc-abc123', session: 'orc-master-1a2b3c4d' };
const project = { id: 'p-1', name: "Bob's app", root: '/work/app', env: { ORC_PROJECT_ID: 'p-1', ORC_STATE_DIR: '/state/p 1' } };

/** `sh -n` parses a script without running it. */
function parsesAsShell(script: string): boolean {
  return spawnSync('/bin/sh', ['-n', '-c', script]).status === 0;
}

describe('masterPaneScript', () => {
  it('attaches to the master with input, on its own socket and exact session, with TMUX unset', () => {
    const script = masterPaneScript(master, project, { tmux: 'tmux', trueColor: false });
    expect(script).toContain('unset TMUX');
    expect(script).toContain(`'tmux' -L 'orc-abc123' attach-session -t '=orc-master-1a2b3c4d'`);
    expect(script).not.toMatch(/attach-session -r/);
    expect(parsesAsShell(script)).toBe(true);
  });

  it('detaches only the cockpit client showing the pane when the master is detached from while it runs', () => {
    const script = masterPaneScript(master, project, { tmux: '/opt/tmux', trueColor: false });
    expect(script).toContain(`TMUX=$cockpit_tmux '/opt/tmux' detach-client 2>/dev/null`);
    expect(script).not.toContain('detach-client -s');
  });

  it('keeps a failed attach on screen and retries without detaching the cockpit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-fake-tmux-'));
    try {
      // A tmux whose master session exists but whose attach fails; every call is logged.
      const fake = join(dir, 'tmux');
      writeFileSync(fake, `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(dir, 'calls'))}\ncase "$*" in *attach-session*) echo 'open terminal failed' >&2; exit 1;; esac\nexit 0\n`, { mode: 0o755 });
      // Stop the loop at its first retry pause.
      const script = masterPaneScript(master, project, { tmux: fake, trueColor: false }).replace('sleep 5', 'exit 7');
      const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, TMUX: '/x,1,0' } });
      expect(result.status).toBe(7);
      expect(result.stderr).toContain('open terminal failed');
      expect(result.stdout).toContain('Could not attach to the master; retrying in 5 s.');
      expect(readFileSync(join(dir, 'calls'), 'utf8')).not.toContain('detach-client');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tells how to restart a master that is not running, quoting the project name', () => {
    const script = masterPaneScript(master, project, { tmux: 'tmux', trueColor: false });
    expect(script).toContain("Master '\\''master'\\'' of Bob'\\''s app is not running.");
    expect(script).toContain("Start it: cd '\\''/work/app'\\'' && orc start-session");
    expect(parsesAsShell(script)).toBe(true);
  });

  it('announces 24-bit colour to the nested client only when the terminal has it', () => {
    expect(masterPaneScript(master, project, { tmux: 'tmux', trueColor: true })).toContain(`'tmux' -T RGB -L 'orc-abc123' attach-session`);
    expect(masterPaneScript(master, project, { tmux: 'tmux', trueColor: false })).not.toContain('-T RGB');
  });
});

describe('sidebarPaneScript', () => {
  it('selects the project and reruns the watch command', () => {
    const script = sidebarPaneScript(project, ['/usr/bin/node', '/orc/cli/orc.js', 'watch']);
    expect(script).toContain("export ORC_PROJECT_ID='p-1'");
    expect(script).toContain("export ORC_STATE_DIR='/state/p 1'");
    expect(script).toContain("'/usr/bin/node' '/orc/cli/orc.js' 'watch'");
    expect(script).toMatch(/while :; do[\s\S]*done$/);
    // TMUX tells orc watch it runs in the cockpit, so Enter opens agent tabs.
    expect(script).not.toContain('unset TMUX');
    expect(parsesAsShell(script)).toBe(true);
  });
});

describe('resolveCockpitKeys', () => {
  it('defaults to F12 and function keys, none of them Ctrl-], Alt or an AltGr character', () => {
    const { keys, problems } = resolveCockpitKeys({});
    expect(problems).toEqual([]);
    expect(keys).toEqual(DEFAULT_COCKPIT_KEYS);
    expect(keys.prefix).toBe('F12');
    expect(Object.values(keys.direct)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11']);
  });

  it('takes the prefix and direct keys from the environment', () => {
    const { keys, problems } = resolveCockpitKeys({ ORC_COCKPIT_PREFIX: ' C-a ', ORC_COCKPIT_KEYS: 'tab1=M-1, dashboard=C-F10,attention=none' });
    expect(problems).toEqual([]);
    expect(keys.prefix).toBe('C-a');
    expect(keys.direct).toMatchObject({ tab1: 'M-1', tab2: 'F2', dashboard: 'C-F10', attention: null });
  });

  it('reports invalid keys and entries and keeps the defaults', () => {
    const { keys, problems } = resolveCockpitKeys({ ORC_COCKPIT_PREFIX: 'Ctrl-]', ORC_COCKPIT_KEYS: 'tab1=a,tab2=Hyper-x,bogus=F3,tab4' });
    expect(keys).toEqual(DEFAULT_COCKPIT_KEYS);
    expect(problems).toEqual([
      "ORC_COCKPIT_PREFIX: unknown key 'Ctrl-]'; using F12",
      "ORC_COCKPIT_KEYS: 'a' cannot be the tab1 key (a function key F1-F12, or a C- or M- key); using F1",
      "ORC_COCKPIT_KEYS: 'Hyper-x' cannot be the tab2 key (a function key F1-F12, or a C- or M- key); using F2",
      expect.stringContaining("unknown entry 'bogus=F3'"),
      expect.stringContaining("unknown entry 'tab4'"),
    ]);
  });

  it('drops a direct key that is the prefix or another action\'s key', () => {
    const { keys, problems } = resolveCockpitKeys({ ORC_COCKPIT_PREFIX: 'F1', ORC_COCKPIT_KEYS: 'attention=F10' });
    expect(keys.direct).toMatchObject({ tab1: null, dashboard: 'F10', attention: null });
    expect(problems).toEqual([
      "ORC_COCKPIT_KEYS: F1 is already the prefix or another action's key; tab1 has no direct key",
      "ORC_COCKPIT_KEYS: F10 is already the prefix or another action's key; attention has no direct key",
    ]);
  });
});

describe('isTmuxKeyName', () => {
  it('accepts tmux key names and rejects the rest', () => {
    for (const key of ['F12', 'f5', 'C-]', 'M-x', 'C-M-Left', 'PageUp', '&']) expect(isTmuxKeyName(key)).toBe(true);
    for (const key of ['', 'F13', 'Ctrl-a', 'C-', 'ö', 'two']) expect(isTmuxKeyName(key)).toBe(false);
  });
});

describe('cockpitKeysHint', () => {
  it('names the default keys', () => {
    expect(cockpitKeysHint(DEFAULT_COCKPIT_KEYS))
      .toBe('F1-F9: tab | F10: sidebar | F12 o: switch pane | F12 n/p: next/previous tab | F12 N/P: project | F12 d: detach');
  });

  it('spells out modifiers and leaves out unbound keys', () => {
    const direct = Object.fromEntries(Object.keys(DEFAULT_COCKPIT_KEYS.direct).map((action) => [action, null])) as typeof DEFAULT_COCKPIT_KEYS.direct;
    expect(cockpitKeysHint({ prefix: 'C-a', direct: { ...direct, tab1: 'M-1' } }))
      .toBe('Alt-1: tab | Ctrl-a o: switch pane | Ctrl-a n/p: next/previous tab | Ctrl-a N/P: project | Ctrl-a d: detach');
  });
});

describe('cockpitServerOptions', () => {
  it('claims only its prefix and direct keys, passes Ctrl-b through and turns the mouse on', () => {
    const options = cockpitServerOptions({ trueColor: false, terminal: 'tmux-256color', keys: DEFAULT_COCKPIT_KEYS, orc: ORC });
    expect(options).toContainEqual(['set-option', '-g', 'prefix', 'F12']);
    expect(options).toContainEqual(['set-option', '-g', 'prefix2', 'None']);
    expect(options).toContainEqual(['unbind-key', '-q', 'C-b']);
    expect(options).toContainEqual(['bind-key', 'F12', 'send-prefix']);
    expect(options).toContainEqual(['bind-key', '-n', 'F1', ...runShell('tab 1')]);
    expect(options).toContainEqual(['bind-key', '-n', 'F9', ...runShell('tab 9')]);
    expect(options).toContainEqual(['bind-key', '-n', 'F10', 'select-pane', '-t', '{left}']);
    expect(options).toContainEqual(['bind-key', '-n', 'F11', ...runShell('attention')]);
    expect(options).toContainEqual(['set-option', '-g', 'mouse', 'on']);
    expect(options).toContainEqual(['set-option', '-g', 'base-index', '1']);
    expect(options).toContainEqual(['set-option', '-g', 'default-terminal', 'tmux-256color']);
    // A tab's pane exiting tells the tab bar to re-read the tab state.
    expect(options).toContainEqual(['set-hook', '-g', 'pane-exited', 'wait-for -S orc-cockpit-changed']);
    expect(options.flat()).not.toContain('C-]');
    expect(options.flat()).not.toContain('terminal-features');
    // A new cockpit has nothing to unbind but tmux's own prefix.
    expect(options.filter((command) => command[0] === 'unbind-key')).toEqual([['unbind-key', '-q', 'C-b']]);
  });

  it('adds RGB for a truecolour terminal', () => {
    expect(cockpitServerOptions({ trueColor: true, terminal: 'tmux-256color', keys: DEFAULT_COCKPIT_KEYS, orc: ORC }))
      .toContainEqual(['set-option', '-as', 'terminal-features', ',*:RGB']);
  });
});

describe('cockpitKeyOptions', () => {
  it('unbinds the keys an earlier cockpit bound before binding these, and records them', () => {
    const options = cockpitKeyOptions(DEFAULT_COCKPIT_KEYS, { prefix: 'C-]', direct: ['F3', 'M-1'] }, ORC);
    expect(options.slice(0, 3)).toEqual([['unbind-key', '-q', 'C-]'], ['unbind-key', '-q', '-n', 'F3'], ['unbind-key', '-q', '-n', 'M-1']]);
    expect(options).toContainEqual(['bind-key', '-n', 'F3', ...runShell('tab 3')]);
    expect(options).toContainEqual(['set-option', '-g', '@orc_cockpit_prefix', 'F12']);
    expect(options).toContainEqual(['set-option', '-g', '@orc_cockpit_direct', 'F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11']);
    expect(options).toContainEqual(['set-option', '-g', 'status-right', cockpitKeysHint(DEFAULT_COCKPIT_KEYS)]);
  });

  it('leaves holding windows out of the status line', () => {
    const options = cockpitKeyOptions(DEFAULT_COCKPIT_KEYS, null, ORC);
    expect(options).toContainEqual(['set-option', '-g', 'window-status-format', '#{?#{@orc_holding},,#I:#W#F }']);
    expect(options).toContainEqual(['set-option', '-g', 'window-status-current-format', '#{?#{@orc_holding},,#I:#W#F }']);
    expect(options).toContainEqual(['set-option', '-g', 'window-status-separator', '']);
  });

  it('points the prefix tab keys at orc cockpit: n/p, 1-9, & for the active project, N/P for projects', () => {
    const options = cockpitKeyOptions(DEFAULT_COCKPIT_KEYS, null, ORC);
    expect(options).toContainEqual(['bind-key', 'n', ...runShell('next')]);
    expect(options).toContainEqual(['bind-key', 'p', ...runShell('prev')]);
    expect(options).toContainEqual(['bind-key', '&', ...runShell('close')]);
    expect(options).toContainEqual(['bind-key', '1', ...runShell('tab 1')]);
    expect(options).toContainEqual(['bind-key', '9', ...runShell('tab 9')]);
    expect(options).toContainEqual(['bind-key', 'N', ...runShell('project next')]);
    expect(options).toContainEqual(['bind-key', 'P', ...runShell('project prev')]);
  });
});

describe('cockpitRunShell', () => {
  it('quotes orc for the shell and doubles # so tmux format expansion leaves the path alone', () => {
    expect(cockpitRunShell(['/opt/node #2/bin/node', "/it's/orc.js"], ['tab', '1'])).toEqual([
      'run-shell', `'/opt/node ##2/bin/node' '/it'\\''s/orc.js' 'cockpit' 'tab' '1' --client='#{client_name}'`,
    ]);
  });
});

const pane = (fields: Omit<Partial<CockpitPane>, 'role'> & { role?: string }): CockpitPane => ({
  paneId: '%0', windowId: '@0', windowName: 'w', inFrame: false, holding: '', projectId: '', agentId: '', masterKey: '', columns: 80, rows: 24,
  ...fields, role: (fields.role ?? '') as CockpitPane['role'],
});

describe('frame', () => {
  it('keeps the sidebar width and the tab bar height, restoring them whenever the window is resized', () => {
    expect([SIDEBAR_COLUMNS, TAB_BAR_ROWS]).toEqual([34, 3]);
    expect(frameSizeCommands('%1', '%2')).toEqual([['resize-pane', '-t', '%1', '-x', '34'], ['resize-pane', '-t', '%2', '-y', '3']]);
    expect(frameResizeHook('@1', '%1', '%2')).toEqual(['set-hook', '-w', '-t', '@1', 'window-resized', 'resize-pane -t %1 -x 34 ; resize-pane -t %2 -y 3']);
  });

  it('reads panes split on <|>, so a project id with spaces survives', () => {
    const out = ['%3<|>@1<|>orc<|>1<|>agent<|>w1<|><|>125x36<|>unregistered:/s/my proj<|>', '%4<|>@2<|>my proj<|><|>keeper<|><|><|>125x36<|><|>unregistered:/s/my proj', ''].join('\n');
    expect(parseCockpitPanes(out)).toEqual([
      pane({ paneId: '%3', windowId: '@1', windowName: 'orc', inFrame: true, role: 'agent', agentId: 'w1', projectId: 'unregistered:/s/my proj', columns: 125, rows: 36 }),
      pane({ paneId: '%4', windowId: '@2', windowName: 'my proj', role: 'keeper', holding: 'unregistered:/s/my proj', columns: 125, rows: 36 }),
    ]);
  });

  it('knows a tab by its pane options: a master or message pane is the master tab, keepers and frame panes are none', () => {
    expect(paneTab(pane({ role: 'master', projectId: 'p-1', masterKey: 'k' }))).toEqual({ projectId: 'p-1', agentId: null });
    expect(paneTab(pane({ role: 'message', projectId: 'p-1' }))).toEqual({ projectId: 'p-1', agentId: null });
    expect(paneTab(pane({ role: 'agent', projectId: 'p-1', agentId: 'w1' }))).toEqual({ projectId: 'p-1', agentId: 'w1' });
    for (const role of ['keeper', 'sidebar', 'tabbar', 'placeholder']) expect(paneTab(pane({ role, projectId: 'p-1' }))).toBeNull();
    expect(paneTab(pane({ role: 'agent', projectId: 'p-1' }))).toBeNull();
  });

  it('finds the frame\'s sidebar, tab bar and slot; a closed slot is null; no frame window is no frame', () => {
    const panes = [
      pane({ paneId: '%1', windowId: '@1', inFrame: true, role: 'sidebar' }),
      pane({ paneId: '%2', windowId: '@1', inFrame: true, role: 'tabbar' }),
      pane({ paneId: '%5', windowId: '@1', inFrame: true, role: 'master', projectId: 'p-1' }),
      pane({ paneId: '%6', windowId: '@2', holding: 'p-1', role: 'keeper' }),
    ];
    expect(frameOf(panes)).toEqual({ windowId: '@1', sidebar: '%1', tabbar: '%2', slot: panes[2] });
    expect(frameOf(panes.filter((entry) => entry.paneId !== '%5'))?.slot).toBeNull();
    expect(frameOf(panes.slice(3))).toBeNull();
  });

  it('focuses the slot\'s pane in the frame window; nothing without a frame or a slot', () => {
    const panes = [
      pane({ paneId: '%1', windowId: '@1', inFrame: true, role: 'sidebar' }),
      pane({ paneId: '%2', windowId: '@1', inFrame: true, role: 'tabbar' }),
      pane({ paneId: '%5', windowId: '@1', inFrame: true, role: 'master', projectId: 'p-1' }),
    ];
    expect(focusSlotCommands(frameOf(panes))).toEqual([['select-window', '-t', '@1'], ['select-pane', '-t', '%5']]);
    expect(focusSlotCommands(frameOf(panes.slice(0, 2)))).toBeNull();
    expect(focusSlotCommands(null)).toBeNull();
  });

  it('names a tab pane with pane options, which move with it when it is swapped', () => {
    expect(tabPaneOptions('%7', { role: 'agent', projectId: 'p-1', agentId: 'w1' })).toEqual([
      ['set-option', '-p', '-t', '%7', '@orc_role', 'agent'],
      ['set-option', '-p', '-t', '%7', '@orc_tab_project', 'p-1'],
      ['set-option', '-p', '-t', '%7', '@orc_tab_agent', 'w1'],
      ['set-option', '-p', '-t', '%7', '@orc_master_key', ''],
    ]);
  });
});

describe('slotCommands', () => {
  const frame = { windowId: '@1', sidebar: '%1', tabbar: '%2' };
  const holding = (projectId: string) => ({ 'p-1': '@2', 'p-2': '@3' })[projectId] ?? null;
  const focus = (paneId: string) => [['select-window', '-t', '@1'], ['select-pane', '-t', paneId]];

  it('swaps a tab of the same project into the slot; the shown one takes its place in the holding window', () => {
    const slot = pane({ paneId: '%5', windowId: '@1', inFrame: true, role: 'master', projectId: 'p-1' });
    const target = pane({ paneId: '%8', windowId: '@2', holding: 'p-1', role: 'agent', projectId: 'p-1', agentId: 'w1' });
    expect(slotCommands({ ...frame, slot }, target, holding)).toEqual([
      ['swap-pane', '-d', '-s', '%8', '-t', '%5'],
      ...focus('%8'),
    ]);
  });

  it('moves another project\'s tab back to its own holding window', () => {
    const slot = pane({ paneId: '%5', windowId: '@1', inFrame: true, role: 'agent', projectId: 'p-1', agentId: 'w1' });
    const target = pane({ paneId: '%9', windowId: '@3', holding: 'p-2', role: 'master', projectId: 'p-2' });
    expect(slotCommands({ ...frame, slot }, target, holding)).toEqual([
      ['swap-pane', '-d', '-s', '%9', '-t', '%5'],
      ['join-pane', '-d', '-s', '%5', '-t', '@2'],
      ...focus('%9'),
    ]);
  });

  it('closes a placeholder it replaces, and only focuses a tab already shown', () => {
    const slot = pane({ paneId: '%3', windowId: '@1', inFrame: true, role: 'placeholder' });
    const target = pane({ paneId: '%9', windowId: '@3', holding: 'p-2', role: 'master', projectId: 'p-2' });
    expect(slotCommands({ ...frame, slot }, target, holding)).toEqual([
      ['swap-pane', '-d', '-s', '%9', '-t', '%3'],
      ['kill-pane', '-t', '%3'],
      ...focus('%9'),
    ]);
    expect(slotCommands({ ...frame, slot: target }, target, holding)).toEqual(focus('%9'));
  });
});

describe('holdingFitCommands', () => {
  it('stacks a holding window\'s panes each at the slot\'s size, borders included', () => {
    expect(holdingFitCommands('@2', 3, 125, 36)).toEqual([
      ['set-option', '-w', '-t', '@2', 'window-size', 'manual'],
      ['resize-window', '-t', '@2', '-x', '125', '-y', String(3 * 36 + 2)],
      ['select-layout', '-t', '@2', 'even-vertical'],
    ]);
  });
});

describe('pane scripts', () => {
  it('a stopped project shows the command that starts it and waits, starting nothing', () => {
    const script = messagePaneScript({ projectName: "Bob's app", root: '/work/my app' });
    expect(parsesAsShell(script)).toBe(true);
    expect(script).toContain("Bob'\\''s app is not running in the cockpit.");
    expect(script).toContain(startCommand('/work/my app').replace(/'/g, "'\\''"));
    expect(startCommand('/work/my app')).toBe("cd '/work/my app' && orc start-session");
    expect(script).not.toMatch(/^\s*(orc|cd) /m);
    expect(cockpitStoppedProject({ project_id: 'p-1', name: 'app', state_dir: '/s', target_repo_root: '/work/app' }))
      .toEqual({ projectId: 'p-1', projectName: 'app', root: '/work/app' });
  });

  it('the keeper, the placeholder and the tab bar parse as shell; the tab bar runs orc cockpit bar', () => {
    for (const script of [keeperPaneScript(), placeholderPaneScript(), tabBarPaneScript(ORC)]) expect(parsesAsShell(script)).toBe(true);
    expect(tabBarPaneScript(ORC)).toContain("'/usr/bin/node' '/orc/cli/orc.js' 'cockpit' 'bar'");
  });
});

describe('cockpitServerEnv', () => {
  it('drops the outer tmux, project selection and session secrets, keeping other orc settings', () => {
    const env = cockpitServerEnv({
      PATH: '/bin', TMUX: '/tmp/x,1,0', TMUX_PANE: '%1', TMUX_TMPDIR: '/t', ORC_PROJECT_ID: 'p', ORC_STATE_DIR: '/s',
      ORC_CONTROL_SOCKET: '/s/c.sock', ORC_PROJECT_FLAG: 'p', ORC_MASTER_SECRET: 'secret', CLAUDECODE: '1', ORC_TMUX_BIN: '/opt/tmux',
    });
    expect(env).toEqual({ PATH: '/bin', TMUX_TMPDIR: '/t', ORC_TMUX_BIN: '/opt/tmux' });
  });
});

describe('cockpitAttachCommand / insideCockpit', () => {
  it('attaches to the cockpit session on the cockpit server', () => {
    process.env.ORC_TMUX_BIN = '/opt/tmux';
    expect(cockpitAttachCommand()).toEqual({
      command: '/opt/tmux', args: ['-L', COCKPIT_SOCKET, '-f', '/dev/null', 'attach-session', '-t', '=cockpit'],
    });
  });

  it('recognises TMUX naming the cockpit server only', () => {
    expect(insideCockpit({ TMUX: `${tmuxSocketPath(COCKPIT_SOCKET)},123,0` })).toBe(true);
    expect(insideCockpit({ TMUX: `${tmuxSocketPath('default')},123,0` })).toBe(false);
    expect(insideCockpit({})).toBe(false);
  });
});

describe('terminalHasTrueColor', () => {
  it.each([['truecolor', true], ['24bit', true], ['256', false], [undefined, false]])('COLORTERM=%s → %s', (value, expected) => {
    expect(terminalHasTrueColor(value === undefined ? {} : { COLORTERM: value })).toBe(expected);
  });
});

describe('agent tabs', () => {
  it('runs the stream with ORC_* and TMUX unset first, then says when it ended and waits to close or reconnect', () => {
    const script = agentTabScript({
      agentId: 'w1', projectName: "Bob's app", command: ['/usr/bin/node', '/orc/cli/orc.ts', 'terminal', 'w1', '--write', '--project=p-1'],
      close: ['/opt/node #2/node', '/orc/cli/orc.ts', 'cockpit', 'close', 'w1'], env: { ORC_STATE_DIR: '/state/p 1' },
    }, '/opt/tmux');
    expect(parsesAsShell(script)).toBe(true);
    const lines = script.split('\n');
    expect(lines[0]).toBe('cockpit_tmux=$TMUX');
    expect(lines[1]).toBe('unset TMUX ORC_PROJECT_ID ORC_STATE_DIR ORC_CONTROL_SOCKET ORC_PROJECT_FLAG');
    expect(lines[2]).toBe("export ORC_STATE_DIR='/state/p 1'");
    expect(script).toContain("'/usr/bin/node' '/orc/cli/orc.ts' 'terminal' 'w1' '--write' '--project=p-1'");
    expect(script).toContain("The terminal of w1 (Bob'\\''s app) is closed");
    expect(script).toContain('[ "$answer" = r ] && continue');
    // Enter closes the tab through the cockpit server, which outlives this pane; # is doubled for run-shell.
    expect(script).toContain("TMUX=$cockpit_tmux '/opt/tmux' run-shell -b ''\\''/opt/node ##2/node'\\'' '\\''/orc/cli/orc.ts'\\'' '\\''cockpit'\\'' '\\''close'\\'' '\\''w1'\\'''");
  });
});

describe('cockpitAgentTab', () => {
  const orc = ['/usr/bin/node', '/orc/cli/orc.js'];

  it('streams a registered project\'s agent with --project', () => {
    expect(cockpitAgentTab('w1', { project_id: 'p-1', name: 'app', state_dir: '/s/p-1', target_repo_root: '/work/app' }, orc)).toEqual({
      projectId: 'p-1', projectName: 'app', agentId: 'w1', root: '/work/app',
      command: [...orc, 'terminal', 'w1', '--write', '--project=p-1'], close: [...orc, 'cockpit', 'close', 'w1'], env: {},
    });
  });

  it('selects an unregistered project by its state directory', () => {
    const tab = cockpitAgentTab('w1', { project_id: 'unregistered:/s/x', name: 'x', state_dir: '/s/x', target_repo_root: '/work/x' }, orc);
    expect(tab.command).toEqual([...orc, 'terminal', 'w1', '--write']);
    expect(tab.env).toEqual({ ORC_STATE_DIR: '/s/x' });
  });
});

describe('withCockpitLock', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('holds the lock while the update runs and releases it, even when the update throws', () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-cockpit-lock-'));
    const path = join(dir, 'orc-cockpit.lock');
    expect(withCockpitLock(() => JSON.parse(readFileSync(path, 'utf8')).pid, path)).toBe(process.pid);
    expect(() => withCockpitLock(() => { throw new Error('boom'); }, path)).toThrow('boom');
    expect(withCockpitLock(() => 'again', path)).toBe('again');
  });

  it('breaks the stale lock of a holder that died', () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-cockpit-lock-'));
    const path = join(dir, 'orc-cockpit.lock');
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    writeFileSync(path, JSON.stringify({ pid: Number(dead), token: 'x' }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(withCockpitLock(() => 'taken', path)).toBe('taken');
  });

  it('gives up with a clear message while a live holder keeps the lock', () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-cockpit-lock-'));
    const path = join(dir, 'orc-cockpit.lock');
    writeFileSync(path, JSON.stringify({ pid: process.ppid, token: 'x' }));
    expect(() => withCockpitLock(() => 'never', path)).toThrow('another cockpit action is still running');
  }, 15_000);

  it('serializes two processes updating at once: neither update is lost', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-cockpit-lock-'));
    const path = join(dir, 'orc-cockpit.lock');
    const counter = join(dir, 'counter');
    writeFileSync(counter, '0');
    // Each child reads the counter, waits, and writes it back +1: without the lock one increment is lost.
    const child = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { withCockpitLock } from ${JSON.stringify(new URL('./tmuxCockpit.ts', import.meta.url).href)};
      for (let i = 0; i < 5; i += 1) withCockpitLock(() => {
        const value = Number(readFileSync(${JSON.stringify(counter)}, 'utf8'));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        writeFileSync(${JSON.stringify(counter)}, String(value + 1));
      }, ${JSON.stringify(path)});
    `;
    const { spawn } = await import('node:child_process');
    const run = () => new Promise<number | null>((resolve) => {
      spawn(process.execPath, ['--input-type=module', '-e', child], { stdio: 'inherit' }).on('exit', resolve);
    });
    expect(await Promise.all([run(), run()])).toEqual([0, 0]);
    expect(readFileSync(counter, 'utf8')).toBe('10');
  }, 20_000);
});

describe('task explorer pane', () => {
  it('runs the explorer for the project, then has the cockpit close it', () => {
    const script = explorerPaneScript(['node', '/orc/orc.js'], 'p-1', '/usr/bin/tmux');
    expect(script).toContain("'node' '/orc/orc.js' 'cockpit' 'explorer' 'p-1'");
    expect(script).toContain("'/usr/bin/tmux' run-shell -b");
    expect(script).toContain("'\\''tasks'\\'' '\\''close'\\''");
    expect(script).not.toContain('unset TMUX ');
  });

  it('binds the prefix t to the explorer', () => {
    const options = cockpitKeyOptions(DEFAULT_COCKPIT_KEYS, null, ['node', '/orc/orc.js']);
    const bound = options.find((o) => o[0] === 'bind-key' && o[1] === 't');
    expect(bound?.join(' ')).toContain("cockpit' 'tasks'");
  });
});
