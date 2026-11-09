import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { tmuxSocketPath } from './tmux.ts';
import {
  COCKPIT_PREFIX, COCKPIT_SOCKET, cockpitAttachCommand, cockpitServerEnv, cockpitServerOptions, dashboardPaneScript,
  insideCockpit, masterKey, masterPaneScript, terminalHasTrueColor, windowLayoutCommands,
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

  it('detaches the cockpit when the master is detached from while it runs', () => {
    const script = masterPaneScript(master, project, { tmux: '/opt/tmux', trueColor: false });
    expect(script).toContain(`'/opt/tmux' -L ${COCKPIT_SOCKET} detach-client -s '=cockpit'`);
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
  it('drops the outer tmux, project selection and session secrets', () => {
    const env = cockpitServerEnv({
      PATH: '/bin', TMUX: '/tmp/x,1,0', TMUX_PANE: '%1', TMUX_TMPDIR: '/t', ORC_PROJECT_ID: 'p', ORC_STATE_DIR: '/s',
      ORC_MASTER_SECRET: 'secret', CLAUDECODE: '1',
    });
    expect(env).toEqual({ PATH: '/bin', TMUX_TMPDIR: '/t' });
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
