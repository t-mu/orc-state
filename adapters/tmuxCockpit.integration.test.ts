import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { COCKPIT_PREFIX, COCKPIT_SOCKET, ensureCockpitWindow, type CockpitMaster } from './tmuxCockpit.ts';

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

function open(projectId: string, master: CockpitMaster) {
  return ensureCockpitWindow({
    project: { id: projectId, name: `project-${projectId}`, root: tmpdir(), env: { ORC_PROJECT_ID: projectId } },
    master,
    watchCommand: ['/bin/sh', '-c', 'echo "DASHBOARD $ORC_PROJECT_ID"; exec sleep 600'],
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
    expect(cockpit(['show-options', '-gv', 'prefix'])).toBe(COCKPIT_PREFIX);
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

    // Running it again reuses the window.
    expect(open('a', masterA)).toBe('existing');
    expect(cockpit(['list-windows', '-t', '=cockpit', '-F', '#{window_id}']).split('\n')).toEqual([window]);
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
});
