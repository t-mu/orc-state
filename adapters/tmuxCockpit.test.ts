import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmuxSocketPath } from './tmux.ts';
import {
  COCKPIT_PREFIX, COCKPIT_SOCKET, agentTabScript, agentWindowName, cockpitAttachCommand, cockpitServerEnv, cockpitServerOptions, dashboardPaneScript,
  insideCockpit, masterKey, masterPaneScript, planAgentTab, terminalHasTrueColor, windowLayoutCommands,
} from './tmuxCockpit.ts';

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
    expect(script).toContain('Run orc start-session for this project to start it');
    expect(parsesAsShell(script)).toBe(true);
  });

  it('announces 24-bit colour to the nested client only when the terminal has it', () => {
    expect(masterPaneScript(master, project, { tmux: 'tmux', trueColor: true })).toContain(`'tmux' -T RGB -L 'orc-abc123' attach-session`);
    expect(masterPaneScript(master, project, { tmux: 'tmux', trueColor: false })).not.toContain('-T RGB');
  });
});

describe('dashboardPaneScript', () => {
  it('selects the project and reruns the watch command', () => {
    const script = dashboardPaneScript(project, ['/usr/bin/node', '/orc/cli/orc.js', 'watch']);
    expect(script).toContain("export ORC_PROJECT_ID='p-1'");
    expect(script).toContain("export ORC_STATE_DIR='/state/p 1'");
    expect(script).toContain("'/usr/bin/node' '/orc/cli/orc.js' 'watch'");
    expect(script).toMatch(/while :; do[\s\S]*done$/);
    // TMUX tells orc watch it runs in the cockpit, so Enter opens agent tabs.
    expect(script).not.toContain('unset TMUX');
    expect(parsesAsShell(script)).toBe(true);
  });
});

describe('cockpitServerOptions', () => {
  it('claims only its own prefix and passes Ctrl-b through', () => {
    const options = cockpitServerOptions({ trueColor: false, terminal: 'tmux-256color' });
    expect(options).toContainEqual(['set-option', '-g', 'prefix', COCKPIT_PREFIX]);
    expect(options).toContainEqual(['set-option', '-g', 'prefix2', 'None']);
    expect(options).toContainEqual(['unbind-key', 'C-b']);
    expect(options).toContainEqual(['bind-key', COCKPIT_PREFIX, 'send-prefix']);
    expect(options).toContainEqual(['set-option', '-g', 'default-terminal', 'tmux-256color']);
    // Mouse stays at tmux's default (off), so the terminal handles it as for a direct attach.
    expect(options.flat()).not.toContain('mouse');
    expect(options.flat()).not.toContain('terminal-features');
  });

  it('adds RGB for a truecolour terminal', () => {
    expect(cockpitServerOptions({ trueColor: true, terminal: 'tmux-256color' }))
      .toContainEqual(['set-option', '-as', 'terminal-features', ',*:RGB']);
  });
});

describe('windowLayoutCommands', () => {
  it('splits the dashboard beside the master pane without focusing it, labels the window and focuses the master', () => {
    const commands = windowLayoutCommands('@3', '%7', project, master, 'DASH');
    expect(commands[0]).toEqual(['split-window', '-h', '-d', '-l', '35%', '-t', '%7', '-c', '/work/app', '/bin/sh', '-c', 'DASH']);
    expect(commands).toContainEqual(['set-option', '-w', '-t', '@3', '@orc_project_id', 'p-1']);
    expect(commands).toContainEqual(['set-option', '-w', '-t', '@3', '@orc_master', masterKey(master)]);
    expect(commands).toContainEqual(['set-option', '-w', '-t', '@3', '@orc_master_pane', '%7']);
    expect(commands.slice(-2)).toEqual([['select-window', '-t', '@3'], ['select-pane', '-t', '%7']]);
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
  it('names a tab after its project and agent', () => {
    expect(agentWindowName("Bob's app", 'grisly-moor')).toBe("Bob's app/grisly-moor");
  });

  it('switches to the agent\'s existing tab instead of opening another', () => {
    const windows = [
      { windowId: '@1', projectId: 'p-1', agentProjectId: '', agentId: '' },
      { windowId: '@4', projectId: '', agentProjectId: 'p-1', agentId: 'w1' },
      { windowId: '@2', projectId: 'p-2', agentProjectId: '', agentId: '' },
      { windowId: '@5', projectId: '', agentProjectId: 'p-2', agentId: 'w1' },
    ];
    expect(planAgentTab(windows, 'p-1', 'w1')).toEqual({ action: 'switch', windowId: '@4' });
    expect(planAgentTab(windows, 'p-2', 'w1')).toEqual({ action: 'switch', windowId: '@5' });
  });

  it('opens a new tab after its project\'s last tab, or at the end for a project without one', () => {
    const windows = [
      { windowId: '@1', projectId: 'p-1', agentProjectId: '', agentId: '' },
      { windowId: '@4', projectId: '', agentProjectId: 'p-1', agentId: 'w1' },
      { windowId: '@2', projectId: 'p-2', agentProjectId: '', agentId: '' },
    ];
    expect(planAgentTab(windows, 'p-1', 'w2')).toEqual({ action: 'open', after: '@4' });
    expect(planAgentTab(windows, 'p-2', 'w2')).toEqual({ action: 'open', after: '@2' });
    expect(planAgentTab(windows, 'p-3', 'w2')).toEqual({ action: 'open', after: null });
  });

  it('runs the stream with ORC_* and TMUX unset first, then says when it ended and waits to close or reconnect', () => {
    const script = agentTabScript({
      agentId: 'w1', projectName: "Bob's app", command: ['/usr/bin/node', '/orc/cli/orc.ts', 'terminal', 'w1', '--write', '--project=p-1'],
      env: { ORC_STATE_DIR: '/state/p 1' },
    });
    expect(parsesAsShell(script)).toBe(true);
    const lines = script.split('\n');
    expect(lines[0]).toBe('unset TMUX ORC_PROJECT_ID ORC_STATE_DIR ORC_CONTROL_SOCKET ORC_PROJECT_FLAG');
    expect(lines[1]).toBe("export ORC_STATE_DIR='/state/p 1'");
    expect(script).toContain("'/usr/bin/node' '/orc/cli/orc.ts' 'terminal' 'w1' '--write' '--project=p-1'");
    expect(script).toContain("The terminal of w1 (Bob'\\''s app) is closed");
    expect(script).toContain('[ "$answer" = r ] || exit 0');
  });
});
