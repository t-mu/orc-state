import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmuxSocketPath } from './tmux.ts';
import {
  COCKPIT_SOCKET, DEFAULT_COCKPIT_KEYS, cockpitRunShell, ensureCockpitWindow, openAgentTab, resolveCockpitKeys, switchToMasterTab, type CockpitKeys, type CockpitMaster,
} from './tmuxCockpit.ts';

/** How the cockpit keys run orc: this checkout's entry point. */
const ORC = [process.execPath, fileURLToPath(new URL('../cli/orc.ts', import.meta.url))];

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
/** Fake masters run on their own servers, as each project's master does; fresh names per test, so no test meets a server still exiting. */
let MASTER_SOCKETS: string[] = [];
let testIndex = 0;

function tmux(socket: string, args: string[]) {
  return spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 10_000 });
}

/** A fake provider CLI: prints a marker and echoes its input. */
function startFakeMaster(socket: string, session: string, marker: string) {
  const result = tmux(socket, ['new-session', '-d', '-s', session, '-x', '120', '-y', '40', '/bin/sh', '-c', `echo ${marker}; exec cat`]);
  expect(result.status, result.stderr).toBe(0);
}

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const capture = (pane: string) => tmux(COCKPIT_SOCKET, ['capture-pane', '-p', '-t', pane]).stdout;
const cockpit = (args: string[]) => tmux(COCKPIT_SOCKET, args).stdout.trim();

function open(projectId: string, master: CockpitMaster, keys: CockpitKeys = DEFAULT_COCKPIT_KEYS) {
  return ensureCockpitWindow({
    keys,
    project: { id: projectId, name: `project-${projectId}`, root: tmpdir(), env: { ORC_PROJECT_ID: projectId } },
    master,
    watchCommand: ['/bin/sh', '-c', 'echo "DASHBOARD $ORC_PROJECT_ID"; exec sleep 600'],
    orc: ORC,
    options: { tmux: 'tmux', trueColor: false },
    size: { columns: 160, rows: 40 },
  });
}

/** The window's panes as `id active`, master pane first. */
function panes(window: string): string[] {
  return cockpit(['list-panes', '-t', window, '-F', '#{pane_id} #{pane_active}']).split('\n');
}

describe.skipIf(!hasTmux)('tmux cockpit', () => {
  beforeEach(() => {
    testIndex += 1;
    MASTER_SOCKETS = [`orc-cockpit-test-${process.pid}-${testIndex}-a`, `orc-cockpit-test-${process.pid}-${testIndex}-b`];
  });

  afterEach(async () => {
    for (const socket of [COCKPIT_SOCKET, ...MASTER_SOCKETS]) tmux(socket, ['kill-server']);
    // The cockpit socket name is fixed: the next test must not reach this server while it exits.
    await waitFor(() => /no server running|error connecting/.test(tmux(COCKPIT_SOCKET, ['list-sessions']).stderr));
  });

  it('opens one cockpit with the master focused beside the dashboard, and reuses it', async () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    const masterA = { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' };

    expect(open('a', masterA)).toBe('created-session');
    expect(cockpit(['show-options', '-gv', 'prefix'])).toBe('F12');
    expect(cockpit(['show-options', '-gv', 'mouse'])).toBe('on');
    // Tab 1 is window 1, as F1 and prefix 1 select it.
    expect(cockpit(['list-windows', '-t', '=cockpit', '-F', '#{window_index}'])).toBe('1');
    expect(cockpit(['list-keys', '-T', 'root', 'F1'])).toMatch(/run-shell .*'cockpit' 'tab' '1' --client=/);
    expect(cockpit(['list-keys', '-T', 'prefix', '&'])).toMatch(/run-shell .*'cockpit' 'close' --client=/);
    expect(cockpit(['list-keys', '-T', 'root', 'F10'])).toMatch(/select-pane -t "?\{right\}"?/);
    expect(cockpit(['list-keys', '-T', 'prefix', 'F12'])).toContain('send-prefix');
    // A click focuses the pane and is still passed on to the master pane's own program.
    expect(cockpit(['list-keys', '-T', 'root', 'MouseDown1Pane'])).toContain('send-keys -M');
    const [window] = cockpit(['list-windows', '-t', '=cockpit', '-F', '#{window_id}']).split('\n');
    const [masterPane, dashboardPane] = panes(window);
    expect(masterPane.endsWith(' 1')).toBe(true);
    expect(dashboardPane.endsWith(' 0')).toBe(true);
    // The master pane is a nested client on the master's own server.
    await waitFor(() => capture(masterPane.split(' ')[0]).includes('MASTER-A'));
    await waitFor(() => capture(dashboardPane.split(' ')[0]).includes('DASHBOARD a'));
    await waitFor(() => tmux(MASTER_SOCKETS[0], ['list-clients', '-F', '#{client_readonly}']).stdout.trim() === '0');

    // Keys reach the master through the nested client.
    tmux(COCKPIT_SOCKET, ['send-keys', '-t', masterPane.split(' ')[0], 'hello-master', 'Enter']);
    await waitFor(() => tmux(MASTER_SOCKETS[0], ['capture-pane', '-p', '-t', '=master-a:']).stdout.includes('hello-master'));

    // Detaching the nested client (the master's Ctrl-b d) keeps the pane: it attaches again.
    tmux(MASTER_SOCKETS[0], ['detach-client', '-s', '=master-a']);
    await waitFor(() => tmux(MASTER_SOCKETS[0], ['list-clients']).stdout.trim() === '');
    await waitFor(() => tmux(MASTER_SOCKETS[0], ['list-clients']).stdout.trim() !== '');

    // Running it again reuses the window, and rebuilds a closed dashboard pane.
    tmux(COCKPIT_SOCKET, ['kill-pane', '-t', dashboardPane.split(' ')[0]]);
    expect(open('a', masterA)).toBe('existing');
    expect(cockpit(['list-windows', '-t', '=cockpit', '-F', '#{window_id}']).split('\n')).toEqual([window]);
    const rebuilt = panes(window);
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[0]).toBe(`${masterPane.split(' ')[0]} 1`);
  });

  it('applies the current keys when reattaching to a cockpit created with other keys', () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    startFakeMaster(MASTER_SOCKETS[1], 'master-b', 'MASTER-B');
    const masterA = { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' };
    open('a', masterA);
    open('b', { agentId: 'master', socket: MASTER_SOCKETS[1], session: 'master-b' });
    // Make it a cockpit from before configurable keys: Ctrl-] prefix, nothing recorded, tabs numbered from 0 with a gap.
    for (const args of [
      ['set-option', '-gu', '@orc_cockpit_prefix'], ['set-option', '-gu', '@orc_cockpit_direct'],
      ['set-option', '-g', 'prefix', 'C-]'], ['bind-key', 'C-]', 'send-prefix'], ['set-option', '-g', 'mouse', 'off'],
      ['move-window', '-s', '=cockpit:1', '-t', '=cockpit:0'], ['move-window', '-s', '=cockpit:2', '-t', '=cockpit:5'],
    ]) expect(tmux(COCKPIT_SOCKET, args).status).toBe(0);

    expect(open('a', masterA)).toBe('existing');
    expect(cockpit(['show-options', '-gv', 'prefix'])).toBe('F12');
    expect(cockpit(['show-options', '-gv', 'mouse'])).toBe('on');
    expect(tmux(COCKPIT_SOCKET, ['list-keys', '-T', 'prefix', 'C-]']).status).not.toBe(0);
    expect(cockpit(['list-keys', '-T', 'root', 'F1'])).toMatch(/run-shell .*'cockpit' 'tab' '1'/);
    expect(cockpit(['list-windows', '-t', '=cockpit', '-F', '#{window_index}']).split('\n')).toEqual(['1', '2']);
    expect(cockpit(['show-options', '-gv', '@orc_cockpit_direct'])).toBe('F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11');

    // Recorded keys are unbound on the next reattach with other keys.
    open('a', masterA, resolveCockpitKeys({ ORC_COCKPIT_PREFIX: 'C-a', ORC_COCKPIT_KEYS: 'dashboard=C-F10' }).keys);
    expect(tmux(COCKPIT_SOCKET, ['list-keys', '-T', 'prefix', 'F12']).status).not.toBe(0);
    expect(tmux(COCKPIT_SOCKET, ['list-keys', '-T', 'root', 'F10']).status).not.toBe(0);
    expect(cockpit(['list-keys', '-T', 'root', 'C-F10'])).toMatch(/select-pane -t "?\{right\}"?/);
    expect(cockpit(['list-keys', '-T', 'prefix', 'C-a'])).toContain('send-prefix');
  });

  it('adds a tab for a second project, and waits for a master that stopped', async () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    startFakeMaster(MASTER_SOCKETS[1], 'master-b', 'MASTER-B');
    open('a', { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' });

    expect(open('b', { agentId: 'master', socket: MASTER_SOCKETS[1], session: 'master-b' })).toBe('created-window');
    const windows = cockpit(['list-windows', '-t', '=cockpit', '-F', '#{window_id} #{window_name} #{window_active}']).split('\n');
    expect(windows.map((line) => line.split(' ').slice(1).join(' '))).toEqual(['project-a 0', 'project-b 1']);
    const masterPaneB = panes(windows[1].split(' ')[0])[0].split(' ')[0];
    await waitFor(() => capture(masterPaneB).includes('MASTER-B'));

    // The master exits: the pane says how to restart it, and attaches once it runs again.
    tmux(MASTER_SOCKETS[1], ['kill-session', '-t', '=master-b']);
    await waitFor(() => capture(masterPaneB).includes('is not running'));
    startFakeMaster(MASTER_SOCKETS[1], 'master-b', 'MASTER-B-AGAIN');
    await waitFor(() => capture(masterPaneB).includes('MASTER-B-AGAIN'));
  });

  it('respawns the master pane for a replaced master', async () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    open('a', { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' });
    startFakeMaster(MASTER_SOCKETS[0], 'master-a2', 'MASTER-A2');

    expect(open('a', { agentId: 'master2', socket: MASTER_SOCKETS[0], session: 'master-a2' })).toBe('respawned-master');
    const [window] = cockpit(['list-windows', '-t', '=cockpit', '-F', '#{window_id}']).split('\n');
    await waitFor(() => capture(panes(window)[0].split(' ')[0]).includes('MASTER-A2'));
  });

  it('opens one tab per agent next to its project, switches to it, and closing it leaves the agent running', async () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    startFakeMaster(MASTER_SOCKETS[1], 'master-b', 'MASTER-B');
    open('a', { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' });
    open('b', { agentId: 'master', socket: MASTER_SOCKETS[1], session: 'master-b' });
    // A fake worker session, and a fake `orc terminal`: it streams until the session ends, then says so.
    const workerSocket = `${MASTER_SOCKETS[0]}-w`;
    MASTER_SOCKETS.push(workerSocket);
    startFakeMaster(workerSocket, 'worker-1', 'WORKER-1');
    const alive = () => tmux(workerSocket, ['has-session', '-t', '=worker-1']).status === 0;
    const tab = {
      projectId: 'a', projectName: 'project-a', agentId: 'w1', root: tmpdir(), env: {},
      command: ['/bin/sh', '-c', `echo "STREAM w1 [$ORC_PROJECT_ID]"; while tmux -L ${workerSocket} -f /dev/null has-session -t =worker-1 2>/dev/null; do sleep 0.2; done; echo '[terminal stream ended: session_ended]'`],
    };
    const windows = () => cockpit(['list-windows', '-t', '=cockpit', '-F', '#{window_name} #{window_active}']).split('\n');
    const tabPane = () => cockpit(['list-panes', '-t', '=cockpit:project-a/w1', '-F', '#{pane_id}']);

    expect(openAgentTab(tab)).toBe('opened');
    // Inserted after its project's tab, focused; ORC_* from the cockpit is unset.
    expect(windows()).toEqual(['project-a 0', 'project-a/w1 1', 'project-b 0']);
    await waitFor(() => capture(tabPane()).includes('STREAM w1 []'));

    // Selecting it again switches to the same tab: no second tab, no second stream.
    cockpit(['select-window', '-t', '=cockpit:project-b']);
    expect(openAgentTab(tab)).toBe('switched');
    expect(windows()).toEqual(['project-a 0', 'project-a/w1 1', 'project-b 0']);

    // A master switches to its project's tab, master pane focused.
    expect(switchToMasterTab('a')).toBe(true);
    expect(windows()).toEqual(['project-a 1', 'project-a/w1 0', 'project-b 0']);
    expect(switchToMasterTab('nope')).toBe(false);

    // Closing the tab ends only the stream.
    cockpit(['kill-window', '-t', '=cockpit:project-a/w1']);
    expect(windows()).toEqual(['project-a 1', 'project-b 0']);
    expect(alive()).toBe(true);

    // The session ends: the tab says so instead of hanging, and Enter closes it.
    expect(openAgentTab(tab)).toBe('opened');
    const pane = tabPane();
    tmux(workerSocket, ['kill-session', '-t', '=worker-1']);
    await waitFor(() => capture(pane).includes('The terminal of w1 (project-a) is closed (exit 0).'));
    expect(capture(pane)).toContain('[terminal stream ended: session_ended]');
    cockpit(['send-keys', '-t', pane, 'Enter']);
    await waitFor(() => !windows().some((line) => line.startsWith('project-a/w1')));
  }, 30_000);
  it('drives tabs through orc cockpit from a shell and a key, serializing rapid actions and rebuilding a corrupt state', async () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    startFakeMaster(MASTER_SOCKETS[1], 'master-b', 'MASTER-B');
    // An unregistered project (its state directory names it), so agent tabs open without a project registry.
    const stateDir = mkdtempSync(join(tmpdir(), 'orc-cockpit-tabs-'));
    const projectU = `unregistered:${stateDir}`;
    try {
      open(projectU, { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' });
      open('b', { agentId: 'master', socket: MASTER_SOCKETS[1], session: 'master-b' });
      const inCockpit = { ...process.env, TMUX: `${tmuxSocketPath(COCKPIT_SOCKET)},1,0`, ORC_STATE_DIR: stateDir };
      const orc = (args: string[], env: NodeJS.ProcessEnv = inCockpit) => new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(ORC[0], [...ORC.slice(1), 'cockpit', ...args], { env });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.stderr.on('data', (chunk) => { out += chunk; });
        child.on('exit', (code) => resolve({ code, out: out.trim() }));
      });
      const state = async () => JSON.parse((await orc(['state'])).out);
      const shown = () => cockpit(['list-windows', '-t', '=cockpit', '-F', '#{window_active} #{window_name}']).split('\n')
        .find((line) => line.startsWith('1 '))?.slice(2);
      const names = () => cockpit(['list-windows', '-t', '=cockpit', '-F', '#{window_name}']).split('\n');
      const masters = () => [MASTER_SOCKETS[0], MASTER_SOCKETS[1]].map((socket) => tmux(socket, ['list-sessions']).status);

      // Outside the cockpit it refuses.
      const { TMUX: _tmux, ...outside } = inCockpit;
      expect(await orc(['next'], outside)).toEqual({ code: 1, out: expect.stringContaining('orc cockpit runs inside the cockpit') });

      // Two actions at once: both tabs open, one window each, and the state lists both.
      cockpit(['select-window', '-t', `=cockpit:project-${projectU}`]);
      const [first, second] = await Promise.all([orc(['open', 'w1', projectU]), orc(['open', 'w2', projectU])]);
      expect([first.code, second.code]).toEqual([0, 0]);
      expect(names().filter((name) => name.endsWith('/w1') || name.endsWith('/w2')).length).toBe(2);
      const opened = await state();
      expect(opened.activeProject).toBe(projectU);
      expect([...opened.projects[0].tabs].sort()).toEqual(['w1', 'w2']);

      // Tab 1 is the master; it stays open. next/prev cycle the project's tabs only.
      expect(await orc(['tab', '1'])).toEqual({ code: 0, out: 'Switched to the master tab.' });
      expect(shown()).toBe(`project-${projectU}`);
      expect(await orc(['close'])).toEqual({ code: 1, out: 'The master tab stays open; close agent tabs only.' });
      const [tabA, tabB] = opened.projects[0].tabs as string[];
      expect((await orc(['next'])).code).toBe(0);
      expect(shown()).toBe(`${stateDir.split('/').pop()}/${tabA}`);
      // Closing the active tab closes its window and shows the one that took its place.
      expect((await orc(['close'])).code).toBe(0);
      expect(names().some((name) => name.endsWith(`/${tabA}`))).toBe(false);
      expect(shown()).toBe(`${stateDir.split('/').pop()}/${tabB}`);

      // A key binding runs the same command through run-shell.
      expect(tmux(COCKPIT_SOCKET, cockpitRunShell(ORC, ['project', 'next'])).status).toBe(0);
      expect(shown()).toBe('project-b');
      expect((await state()).activeProject).toBe('b');

      // A corrupt state is rebuilt from the windows; the projects remember their tabs.
      expect(tmux(COCKPIT_SOCKET, ['set-option', '-g', '@orc_cockpit_tabs', '{not json']).status).toBe(0);
      expect(await state()).toEqual({
        activeProject: 'b',
        projects: [{ projectId: projectU, tabs: [tabB], active: null }, { projectId: 'b', tabs: [], active: null }],
      });
      expect((await orc(['project', projectU])).code).toBe(0);
      expect(shown()).toBe(`project-${projectU}`);

      // No master was stopped along the way.
      expect(masters()).toEqual([0, 0]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60_000);
});
