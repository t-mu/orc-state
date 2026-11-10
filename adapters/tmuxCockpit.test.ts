import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmuxSocketPath } from './tmux.ts';
import {
  COCKPIT_SOCKET, DEFAULT_COCKPIT_KEYS, agentTabScript, agentWindowName, cockpitAgentTab, cockpitAttachCommand, cockpitKeyOptions, cockpitKeysHint, cockpitRunShell, cockpitServerEnv,
  cockpitServerOptions, dashboardPaneScript, dashboardPaneWidth, insideCockpit, isTmuxKeyName, resolveCockpitKeys, masterKey, masterPaneScript, planAgentTab, terminalHasTrueColor, windowLayoutCommands, withCockpitLock,
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
      .toBe('F1-F9: tab | F10: dashboard | F12 o: switch pane | F12 n/p: next/previous tab | F12 N/P: project | F12 d: detach');
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
    expect(options).toContainEqual(['bind-key', '-n', 'F10', 'select-pane', '-t', '{right}']);
    expect(options).toContainEqual(['bind-key', '-n', 'F11', ...runShell('attention')]);
    expect(options).toContainEqual(['set-option', '-g', 'mouse', 'on']);
    expect(options).toContainEqual(['set-option', '-g', 'base-index', '1']);
    expect(options).toContainEqual(['set-option', '-g', 'default-terminal', 'tmux-256color']);
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

describe('windowLayoutCommands', () => {
  it('splits the dashboard beside the master pane without focusing it, labels the window and focuses the master', () => {
    const commands = windowLayoutCommands('@3', '%7', 200, project, master, 'DASH');
    expect(commands[0]).toEqual(['split-window', '-h', '-d', '-l', '50', '-t', '%7', '-c', '/work/app', '/bin/sh', '-c', 'DASH']);
    expect(commands).toContainEqual(['set-option', '-w', '-t', '@3', '@orc_project_id', 'p-1']);
    expect(commands).toContainEqual(['set-option', '-w', '-t', '@3', '@orc_master', masterKey(master)]);
    expect(commands).toContainEqual(['set-option', '-w', '-t', '@3', '@orc_master_pane', '%7']);
    expect(commands.slice(-2)).toEqual([['select-window', '-t', '@3'], ['select-pane', '-t', '%7']]);
  });
});

describe('dashboardPaneWidth', () => {
  it('is a sidebar of a quarter of the window within 40–60 columns, and never the primary pane', () => {
    expect(dashboardPaneWidth(286)).toBe(60);
    expect(dashboardPaneWidth(200)).toBe(50);
    expect(dashboardPaneWidth(120)).toBe(40);
    // A narrow window keeps the master the wider pane.
    expect(dashboardPaneWidth(80)).toBe(32);
    expect(dashboardPaneWidth(2)).toBe(1);
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

describe('cockpitAgentTab', () => {
  const orc = ['/usr/bin/node', '/orc/cli/orc.js'];

  it('streams a registered project\'s agent with --project', () => {
    expect(cockpitAgentTab('w1', { project_id: 'p-1', name: 'app', state_dir: '/s/p-1', target_repo_root: '/work/app' }, orc)).toEqual({
      projectId: 'p-1', projectName: 'app', agentId: 'w1', root: '/work/app',
      command: [...orc, 'terminal', 'w1', '--write', '--project=p-1'], env: {},
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

  it('breaks the lock of a holder that died', () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-cockpit-lock-'));
    const path = join(dir, 'orc-cockpit.lock');
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    writeFileSync(path, JSON.stringify({ pid: Number(dead), token: 'x' }));
    expect(withCockpitLock(() => 'taken', path)).toBe('taken');
  });

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
