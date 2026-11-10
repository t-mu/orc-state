import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmuxSocketPath } from './tmux.ts';
import {
  COCKPIT_SOCKET, DEFAULT_COCKPIT_KEYS, cockpitRunShell, ensureCockpitWindow, masterKey, masterPaneScript, openAgentTab, resolveCockpitKeys, switchToMasterTab,
  type CockpitKeys, type CockpitMaster,
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

interface Pane { id: string; window: string; frame: boolean; active: boolean; role: string; project: string; agent: string; width: number; height: number; pid: string }

/** Every pane of the cockpit session, with the options naming it. */
function cockpitPanes(): Pane[] {
  const format = ['#{pane_id}', '#{window_id}', '#{@orc_frame}', '#{&&:#{window_active},#{pane_active}}', '#{@orc_role}', '#{@orc_tab_agent}',
    '#{pane_width}', '#{pane_height}', '#{pane_pid}', '#{@orc_tab_project}'].join('\t');
  return cockpit(['list-panes', '-s', '-t', '=cockpit', '-F', format]).split('\n').filter(Boolean).map((line) => {
    const [id, window, frame, active, role, agent, width, height, pid, project] = line.split('\t');
    return { id, window, frame: frame === '1', active: active === '1', role, project, agent, width: Number(width), height: Number(height), pid };
  });
}

const framePanes = () => cockpitPanes().filter((pane) => pane.frame);
/** The pane in the slot. */
const slot = () => framePanes().find((pane) => pane.role !== 'sidebar' && pane.role !== 'tabbar')!;
const role = (name: string) => framePanes().find((pane) => pane.role === name)!;
/** The tab the slot shows: `<project>` for a master, `<project>/<agent>` for an agent. */
const shown = () => {
  const pane = slot();
  return pane.agent ? `${pane.project}/${pane.agent}` : pane.project;
};
/** The windows the status line lists: holding windows are left out. */
const listedWindows = () => cockpit(['list-windows', '-t', '=cockpit', '-F', '#{?#{@orc_holding},,#{window_name}}']).split('\n').filter(Boolean);

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

  it('opens one window: sidebar, tab bar and the slot showing the master with focus; and reuses it', async () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    const masterA = { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' };

    expect(open('a', masterA)).toBe('created-session');
    expect(cockpit(['show-options', '-gv', 'prefix'])).toBe('F12');
    expect(cockpit(['show-options', '-gv', 'mouse'])).toBe('on');
    expect(cockpit(['list-keys', '-T', 'root', 'F1'])).toMatch(/run-shell .*'cockpit' 'tab' '1' --client=/);
    expect(cockpit(['list-keys', '-T', 'prefix', '&'])).toMatch(/run-shell .*'cockpit' 'close' --client=/);
    expect(cockpit(['list-keys', '-T', 'root', 'F10'])).toMatch(/select-pane -t "?\{left\}"?/);
    expect(cockpit(['list-keys', '-T', 'prefix', 'F12'])).toContain('send-prefix');
    // A click focuses the pane and is still passed on to the pane's own program.
    expect(cockpit(['list-keys', '-T', 'root', 'MouseDown1Pane'])).toContain('send-keys -M');

    // One window is listed: the frame. Its three panes are the sidebar (34 wide), the tab bar (3 high) and the slot.
    expect(listedWindows()).toEqual(['orc']);
    expect(framePanes().map((pane) => pane.role)).toEqual(['sidebar', 'tabbar', 'master']);
    expect(role('sidebar')).toMatchObject({ width: 34, height: 40 });
    expect(role('tabbar').height).toBe(3);
    expect(slot()).toMatchObject({ project: 'a', active: true, height: 36 });
    await waitFor(() => capture(slot().id).includes('MASTER-A'));
    await waitFor(() => capture(role('sidebar').id).includes('DASHBOARD a'));
    await waitFor(() => capture(role('tabbar').id).includes('[project-a]') && capture(role('tabbar').id).includes('[1 master]'));
    await waitFor(() => tmux(MASTER_SOCKETS[0], ['list-clients', '-F', '#{client_readonly}']).stdout.trim() === '0');

    // Keys reach the master through the nested client.
    tmux(COCKPIT_SOCKET, ['send-keys', '-t', slot().id, 'hello-master', 'Enter']);
    await waitFor(() => tmux(MASTER_SOCKETS[0], ['capture-pane', '-p', '-t', '=master-a:']).stdout.includes('hello-master'));

    // Detaching the nested client (the master's Ctrl-b d) keeps the pane: it attaches again.
    tmux(MASTER_SOCKETS[0], ['detach-client', '-s', '=master-a']);
    await waitFor(() => tmux(MASTER_SOCKETS[0], ['list-clients']).stdout.trim() === '');
    await waitFor(() => tmux(MASTER_SOCKETS[0], ['list-clients']).stdout.trim() !== '');

    // Resizing the terminal keeps the sidebar's width and the tab bar's height.
    const masterPane = slot().id;
    expect(tmux(COCKPIT_SOCKET, ['resize-window', '-t', role('sidebar').window, '-x', '220', '-y', '60']).status).toBe(0);
    await waitFor(() => role('sidebar').width === 34 && role('tabbar').height === 3 && slot().width === 220 - 34 - 1);
    expect(tmux(COCKPIT_SOCKET, ['resize-window', '-t', role('sidebar').window, '-x', '100', '-y', '30']).status).toBe(0);
    await waitFor(() => role('sidebar').width === 34 && role('tabbar').height === 3 && slot().height === 30 - 3 - 1);

    // Running it again reuses everything: the same master pane in the slot, focused.
    expect(open('a', masterA)).toBe('existing');
    expect(listedWindows()).toEqual(['orc']);
    expect(slot()).toMatchObject({ id: masterPane, active: true });
  }, 30_000);

  it('applies the current keys when reattaching to a cockpit created with other keys', () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    const masterA = { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' };
    open('a', masterA);
    // Make it a cockpit from before configurable keys: Ctrl-] prefix, nothing recorded.
    for (const args of [
      ['set-option', '-gu', '@orc_cockpit_prefix'], ['set-option', '-gu', '@orc_cockpit_direct'],
      ['set-option', '-g', 'prefix', 'C-]'], ['bind-key', 'C-]', 'send-prefix'], ['set-option', '-g', 'mouse', 'off'],
    ]) expect(tmux(COCKPIT_SOCKET, args).status).toBe(0);

    expect(open('a', masterA)).toBe('existing');
    expect(cockpit(['show-options', '-gv', 'prefix'])).toBe('F12');
    expect(cockpit(['show-options', '-gv', 'mouse'])).toBe('on');
    expect(tmux(COCKPIT_SOCKET, ['list-keys', '-T', 'prefix', 'C-]']).status).not.toBe(0);
    expect(cockpit(['list-keys', '-T', 'root', 'F1'])).toMatch(/run-shell .*'cockpit' 'tab' '1'/);
    expect(cockpit(['show-options', '-gv', '@orc_cockpit_direct'])).toBe('F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11');

    // Recorded keys are unbound on the next reattach with other keys.
    open('a', masterA, resolveCockpitKeys({ ORC_COCKPIT_PREFIX: 'C-a', ORC_COCKPIT_KEYS: 'dashboard=C-F10' }).keys);
    expect(tmux(COCKPIT_SOCKET, ['list-keys', '-T', 'prefix', 'F12']).status).not.toBe(0);
    expect(tmux(COCKPIT_SOCKET, ['list-keys', '-T', 'root', 'F10']).status).not.toBe(0);
    expect(cockpit(['list-keys', '-T', 'root', 'C-F10'])).toMatch(/select-pane -t "?\{left\}"?/);
    expect(cockpit(['list-keys', '-T', 'prefix', 'C-a'])).toContain('send-prefix');
  });

  it('adds a second project to the same window, and waits for a master that stopped', async () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    startFakeMaster(MASTER_SOCKETS[1], 'master-b', 'MASTER-B');
    open('a', { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' });
    const masterPaneA = slot().id;

    expect(open('b', { agentId: 'master', socket: MASTER_SOCKETS[1], session: 'master-b' })).toBe('added-project');
    expect(listedWindows()).toEqual(['orc']);
    expect(slot()).toMatchObject({ project: 'b', active: true });
    const masterPaneB = slot().id;
    // The sidebar's dashboard now runs for b, the project start-session ran in.
    await waitFor(() => capture(role('sidebar').id).includes('DASHBOARD b'));
    await waitFor(() => capture(masterPaneB).includes('MASTER-B'));
    // A's master went back to A's holding window, still attached.
    expect(cockpitPanes().find((pane) => pane.id === masterPaneA)).toMatchObject({ frame: false, project: 'a' });
    expect(tmux(MASTER_SOCKETS[0], ['list-clients']).stdout.trim()).not.toBe('');

    // The master exits: the pane says how to start it, and attaches once it runs again.
    tmux(MASTER_SOCKETS[1], ['kill-session', '-t', '=master-b']);
    await waitFor(() => capture(masterPaneB).includes('is not running'));
    expect(capture(masterPaneB)).toContain('orc start-session');
    startFakeMaster(MASTER_SOCKETS[1], 'master-b', 'MASTER-B-AGAIN');
    await waitFor(() => capture(masterPaneB).includes('MASTER-B-AGAIN'));
  }, 30_000);

  it('respawns the master pane for a replaced master', async () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    open('a', { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' });
    startFakeMaster(MASTER_SOCKETS[0], 'master-a2', 'MASTER-A2');

    expect(open('a', { agentId: 'master2', socket: MASTER_SOCKETS[0], session: 'master-a2' })).toBe('respawned-master');
    await waitFor(() => capture(slot().id).includes('MASTER-A2'));
  });

  it('opens, switches and closes agent tabs in the slot only; a tab shown again keeps its stream; closing leaves the agent running', async () => {
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
      projectId: 'a', projectName: 'project-a', agentId: 'w1', root: tmpdir(), env: {}, close: [...ORC, 'cockpit', 'close', 'w1'],
      command: ['/bin/sh', '-c', `echo "STREAM w1 [$ORC_PROJECT_ID] $$"; while tmux -L ${workerSocket} -f /dev/null has-session -t =worker-1 2>/dev/null; do sleep 0.2; done; echo '[terminal stream ended: session_ended]'`],
    };
    const frame = () => framePanes().filter((pane) => pane.role === 'sidebar' || pane.role === 'tabbar').map((pane) => pane.id);
    const frameBefore = frame();

    expect(openAgentTab(tab)).toBe('opened');
    // Shown in the slot, focused; ORC_* from the cockpit is unset. Nothing but the slot changed.
    expect(shown()).toBe('a/w1');
    expect(slot().active).toBe(true);
    expect(frame()).toEqual(frameBefore);
    expect(listedWindows()).toEqual(['orc']);
    const streamPane = slot().id;
    await waitFor(() => capture(streamPane).includes('STREAM w1 []'));
    const streamLine = capture(streamPane).split('\n').find((line) => line.startsWith('STREAM w1'));

    // Selecting it again shows the same pane: no second tab, no second stream.
    expect(switchToMasterTab('b')).toBe(true);
    expect(shown()).toBe('b');
    // Parked in its holding window it keeps the slot's size, so its agent is never resized; so do the hidden masters.
    const { width, height } = slot();
    for (const parked of cockpitPanes().filter((entry) => !entry.frame && ['agent', 'master'].includes(entry.role))) {
      expect(parked).toMatchObject({ width, height });
    }
    expect(openAgentTab(tab)).toBe('switched');
    expect(slot().id).toBe(streamPane);
    expect(capture(streamPane).split('\n').filter((line) => line.startsWith('STREAM w1'))).toEqual([streamLine]);

    // A master shows its project's master tab.
    expect(switchToMasterTab('a')).toBe(true);
    expect(shown()).toBe('a');
    expect(switchToMasterTab('nope')).toBe(false);
    expect(frame()).toEqual(frameBefore);

    // Closing the tab ends only the stream: its pane is gone, the agent runs.
    expect(cockpitPanes().some((pane) => pane.id === streamPane)).toBe(true);
    tmux(COCKPIT_SOCKET, ['kill-pane', '-t', streamPane]);
    expect(alive()).toBe(true);

    // The session ends: the tab says so instead of hanging, and Enter closes it, showing the master again.
    expect(openAgentTab(tab)).toBe('opened');
    const pane = slot().id;
    tmux(workerSocket, ['kill-session', '-t', '=worker-1']);
    await waitFor(() => capture(pane).includes('The terminal of w1 (project-a) is closed (exit 0).'));
    expect(capture(pane)).toContain('[terminal stream ended: session_ended]');
    cockpit(['send-keys', '-t', pane, 'Enter']);
    await waitFor(() => !cockpitPanes().some((entry) => entry.id === pane));
    expect(shown()).toBe('a');
    expect(frame()).toEqual(frameBefore);
  }, 30_000);
  it('drives tabs through orc cockpit from a shell and a key: rapid actions, project switches that keep each project\'s tabs, a stopped project, a corrupt state', async () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    startFakeMaster(MASTER_SOCKETS[1], 'master-b', 'MASTER-B');
    // Unregistered projects (their state directories name them), so tabs open without a project registry.
    const stateDir = mkdtempSync(join(tmpdir(), 'orc-cockpit-tabs-'));
    const stoppedDir = mkdtempSync(join(tmpdir(), 'orc-cockpit-stopped-'));
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
      const masters = () => [MASTER_SOCKETS[0], MASTER_SOCKETS[1]].map((socket) => tmux(socket, ['list-sessions']).status);
      const frameBefore = framePanes().filter((pane) => pane.role === 'sidebar' || pane.role === 'tabbar').map((pane) => pane.id);

      // Outside the cockpit it refuses.
      const { TMUX: _tmux, ...outside } = inCockpit;
      expect(await orc(['next'], outside)).toEqual({ code: 1, out: expect.stringContaining('orc cockpit runs inside the cockpit') });

      // Two actions at once: both tabs open, one pane each, and the state lists both.
      expect((await orc(['project', projectU])).code).toBe(0);
      const [first, second] = await Promise.all([orc(['open', 'w1', projectU]), orc(['open', 'w2', projectU])]);
      expect([first.code, second.code]).toEqual([0, 0]);
      expect(cockpitPanes().filter((pane) => pane.project === projectU && pane.role === 'agent').map((pane) => pane.agent).sort()).toEqual(['w1', 'w2']);
      const opened = await state();
      expect(opened.activeProject).toBe(projectU);
      expect([...opened.projects[0].tabs].sort()).toEqual(['w1', 'w2']);

      // Tab 1 is the master; it stays open. next/prev cycle the project's tabs only.
      expect(await orc(['tab', '1'])).toEqual({ code: 0, out: 'Switched to the master tab.' });
      expect(shown()).toBe(projectU);
      expect(await orc(['close'])).toEqual({ code: 1, out: 'The master tab stays open; close agent tabs only.' });
      const [tabA, tabB] = opened.projects[0].tabs as string[];
      expect((await orc(['next'])).code).toBe(0);
      expect(shown()).toBe(`${projectU}/${tabA}`);
      // Closing the active tab closes its pane and shows the one that took its place.
      expect((await orc(['close'])).code).toBe(0);
      expect(cockpitPanes().some((pane) => pane.agent === tabA)).toBe(false);
      expect(shown()).toBe(`${projectU}/${tabB}`);
      const tabBPane = slot().id;

      // A key binding runs the same command through run-shell: switching project shows its active tab (its master)...
      expect(tmux(COCKPIT_SOCKET, cockpitRunShell(ORC, ['project', 'next'])).status).toBe(0);
      expect(shown()).toBe('b');
      expect((await state()).activeProject).toBe('b');
      // ...and switching back restores the project's tabs and the tab it showed, the same pane (its stream never reconnected).
      expect((await orc(['project', projectU])).code).toBe(0);
      expect(slot().id).toBe(tabBPane);
      expect((await state()).projects[0]).toEqual({ projectId: projectU, tabs: [tabB], active: tabB });

      // A project that is not running shows the command that starts it; nothing is started.
      const stopped = `unregistered:${stoppedDir}`;
      expect((await orc(['project', stopped])).code).toBe(0);
      expect(slot()).toMatchObject({ role: 'message', project: stopped });
      await waitFor(() => capture(slot().id).includes('is not running in the cockpit') && capture(slot().id).includes('orc start-session'));
      expect((await orc(['project', 'nope'])).out).toContain("unknown project 'nope'");
      expect(shown()).toBe(stopped);

      // A corrupt state is rebuilt from the panes; the projects remember their tabs.
      expect((await orc(['project', 'b'])).code).toBe(0);
      expect(tmux(COCKPIT_SOCKET, ['set-option', '-g', '@orc_cockpit_tabs', '{not json']).status).toBe(0);
      const rebuilt = await state();
      expect(rebuilt.activeProject).toBe('b');
      expect(rebuilt.projects).toHaveLength(3);
      expect(rebuilt.projects).toEqual(expect.arrayContaining([
        { projectId: projectU, tabs: [tabB], active: null },
        { projectId: 'b', tabs: [], active: null },
        { projectId: stopped, tabs: [], active: null },
      ]));
      expect((await orc(['project', projectU])).code).toBe(0);
      expect(shown()).toBe(projectU);

      // Only the slot ever changed, and no master was stopped along the way.
      expect(framePanes().filter((pane) => pane.role === 'sidebar' || pane.role === 'tabbar').map((pane) => pane.id)).toEqual(frameBefore);
      expect(listedWindows()).toEqual(['orc']);
      expect(masters()).toEqual([0, 0]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(stoppedDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('puts back a slot whose pane exited', async () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    open('a', { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' });
    const masterPane = slot().id;
    // A stray pane in the slot exits: the tab bar notices the closed slot and shows the active tab again.
    expect(tmux(COCKPIT_SOCKET, ['swap-pane', '-d', '-s', masterPane, '-t', role('sidebar').id]).status).toBe(0);
    expect(tmux(COCKPIT_SOCKET, ['swap-pane', '-d', '-s', masterPane, '-t', role('sidebar').id]).status).toBe(0);
    const strayHolder = cockpit(['new-window', '-d', '-P', '-F', '#{pane_id}', 'sleep 600']);
    expect(tmux(COCKPIT_SOCKET, ['swap-pane', '-d', '-s', strayHolder, '-t', masterPane]).status).toBe(0);
    tmux(COCKPIT_SOCKET, ['kill-pane', '-t', strayHolder]);
    await waitFor(() => slot()?.id === masterPane && role('tabbar').height === 3 && role('sidebar').width === 34, 10_000);
  }, 30_000);

  it('rebuilds a frame that lost its tab bar, keeping the shown tab running', () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    const masterA = { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' };
    open('a', masterA);
    const { id: masterPane, pid } = slot();
    tmux(COCKPIT_SOCKET, ['kill-pane', '-t', role('tabbar').id]);

    expect(open('a', masterA)).toBe('existing');
    expect(listedWindows()).toEqual(['orc']);
    expect(framePanes().map((pane) => pane.role)).toEqual(['sidebar', 'tabbar', 'master']);
    expect(slot()).toMatchObject({ id: masterPane, pid, active: true });
    expect(role('tabbar').height).toBe(3);
  }, 30_000);

  it('rebuilds a cockpit with the old layout without stopping a master or a stream', async () => {
    startFakeMaster(MASTER_SOCKETS[0], 'master-a', 'MASTER-A');
    startFakeMaster(MASTER_SOCKETS[1], 'master-b', 'MASTER-B');
    const masterA = { agentId: 'master', socket: MASTER_SOCKETS[0], session: 'master-a' };
    const masterB = { agentId: 'master', socket: MASTER_SOCKETS[1], session: 'master-b' };
    const options = { tmux: 'tmux', trueColor: false };
    // The old layout: a window per project (its master pane beside a dashboard) and a window per agent tab.
    const legacyWindow = (name: string, script: string, extra: (window: string, pane: string) => string[][]) => {
      const [window, pane] = cockpit(['new-window', '-d', '-t', '=cockpit:', '-n', name, '-P', '-F', '#{window_id} #{pane_id}', '/bin/sh', '-c', script]).split(' ');
      for (const args of extra(window, pane)) expect(tmux(COCKPIT_SOCKET, args).status).toBe(0);
      return pane;
    };
    expect(tmux(COCKPIT_SOCKET, ['new-session', '-d', '-s', 'cockpit', '-x', '160', '-y', '40', '-n', 'scratch', 'sleep 600']).status).toBe(0);
    const projectWindow = (id: string, master: CockpitMaster) => (window: string, pane: string) => [
      ['split-window', '-h', '-d', '-t', pane, 'sleep 600'],
      ['set-option', '-w', '-t', window, '@orc_project_id', id],
      ['set-option', '-w', '-t', window, '@orc_master', masterKey(master)],
      ['set-option', '-w', '-t', window, '@orc_master_pane', pane],
    ];
    const paneA = legacyWindow('project-a', masterPaneScript(masterA, { name: 'project-a', root: tmpdir() }, options), projectWindow('a', masterA));
    const paneB = legacyWindow('project-b', masterPaneScript(masterB, { name: 'project-b', root: tmpdir() }, options), projectWindow('b', masterB));
    const agentPane = legacyWindow('project-a/w1', 'echo STREAM-W1; exec sleep 600', (window) => [
      ['set-option', '-w', '-t', window, '@orc_agent_project', 'a'],
      ['set-option', '-w', '-t', window, '@orc_agent_id', 'w1'],
    ]);
    cockpit(['kill-window', '-t', '=cockpit:scratch']);
    await waitFor(() => tmux(MASTER_SOCKETS[1], ['list-clients']).stdout.trim() !== '');
    const pids = () => cockpitPanes().filter((pane) => [paneA, paneB, agentPane].includes(pane.id)).map((pane) => pane.pid).sort();
    const before = pids();
    expect(before).toHaveLength(3);

    expect(open('b', masterB)).toBe('existing');
    // One window with the frame; project b's master in the slot; every old pane kept, still running, as a tab.
    expect(listedWindows()).toEqual(['orc']);
    expect(framePanes().map((pane) => pane.role)).toEqual(['sidebar', 'tabbar', 'master']);
    expect(slot()).toMatchObject({ id: paneB, project: 'b', active: true });
    expect(pids()).toEqual(before);
    expect(cockpitPanes().find((pane) => pane.id === paneA)).toMatchObject({ role: 'master', project: 'a', frame: false });
    expect(cockpitPanes().find((pane) => pane.id === agentPane)).toMatchObject({ role: 'agent', project: 'a', agent: 'w1', frame: false });
    expect(switchToMasterTab('a')).toBe(true);
    expect(slot().id).toBe(paneA);
    await waitFor(() => capture(paneA).includes('MASTER-A'));
    expect([MASTER_SOCKETS[0], MASTER_SOCKETS[1]].map((socket) => tmux(socket, ['list-sessions']).status)).toEqual([0, 0]);

    // Reattaching to the new layout restores the active project and its tab.
    expect(openAgentTab({ projectId: 'a', projectName: 'project-a', agentId: 'w1', root: tmpdir(), env: {}, command: ['true'], close: ['true'] })).toBe('switched');
    expect(open('a', masterA)).toBe('existing');
    expect(slot().id).toBe(agentPane);
    expect(capture(agentPane)).toContain('STREAM-W1');
  }, 30_000);
});
