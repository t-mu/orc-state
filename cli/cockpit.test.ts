import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_COCKPIT_KEYS } from '../lib/cockpitKeys.ts';
import { readProcessStart } from '../lib/processIdentity.ts';
import {
  addToCockpit, cockpitLaunch, cockpitTheme, cockpitOpeningHint, cockpitPaths, commandFailure, coordinatorRestartCommand, explorerCommand, insideOrcTmux, launchCockpit,
  oldCockpitLockPath, projectAddHost, readAgentDefinitions, readTextOrNull, registrySettingsHost, retireOldCockpit, agentActionHost, taskResetCommand, type RemoveScout, type RunCommand,
} from './cockpit.ts';
import { ProjectRegistry } from '../lib/projectRegistry.ts';
import { BUILT_IN_THEMES } from '../lib/cockpit2/theme.ts';
import { createViewStateStore } from '../lib/cockpit2/viewState.ts';

describe('cockpitPaths', () => {
  it('keeps the cockpit lock and the view state under orc\'s data home', () => {
    expect(cockpitPaths('/home/u/.local/share/orc-state')).toEqual({
      lockPath: '/home/u/.local/share/orc-state/cockpit/cockpit.lock',
      viewStatePath: '/home/u/.local/share/orc-state/cockpit/view-state.json',
      viewStateLockPath: '/home/u/.local/share/orc-state/cockpit/view-state.lock',
    });
  });
});

describe('insideOrcTmux and cockpitLaunch', () => {
  const dir = '/tmp/tmux-1000';
  const tmux = (socket: string) => ({ TMUX: `${dir}/${socket},4242,0` });

  it('is true in a pane of a project\'s tmux server or a cockpit\'s, where a cockpit would nest', () => {
    expect(insideOrcTmux(tmux('orc-0123456789ab'), dir)).toBe(true);
    expect(insideOrcTmux(tmux('orc-explorer'), dir)).toBe(true);
    // An older orc's cockpit servers, until a launch retires them.
    expect(insideOrcTmux(tmux('orc-cockpit'), dir)).toBe(true);
    expect(insideOrcTmux(tmux('orc-cockpit2'), dir)).toBe(true);
  });

  it('is false outside tmux, in the user\'s own tmux, and for a socket elsewhere', () => {
    expect(insideOrcTmux({}, dir)).toBe(false);
    expect(insideOrcTmux(tmux('default'), dir)).toBe(false);
    expect(insideOrcTmux(tmux('orc-notahexname'), dir)).toBe(false);
    expect(insideOrcTmux({ TMUX: '/elsewhere/orc-0123456789ab,1,0' }, dir)).toBe(false);
  });

  it('runs the cockpit here unless that nests it, then adds the project instead', () => {
    expect(cockpitLaunch(false)).toBe('run');
    expect(cockpitLaunch(true)).toBe('add');
  });
});

describe('retireOldCockpit', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A tmux stand-in recording each call's arguments; it exits 1, as tmux does when no such server runs. */
  function fakeTmux(): { tmux: string; calls: () => string[][] } {
    const tmux = join(dir, 'tmux');
    const log = join(dir, 'args');
    writeFileSync(tmux, `#!/bin/sh\nprintf '%s ' "$@" >> '${log}'\necho >> '${log}'\nexit 1\n`);
    chmodSync(tmux, 0o755);
    return { tmux, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => line.trim().split(' ')) : []) };
  }

  it('ends only an older orc\'s cockpit servers, without reading a tmux config', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-retire-old-cockpit-'));
    const { tmux, calls } = fakeTmux();
    await expect(retireOldCockpit(dir, tmux)).resolves.toBeUndefined();
    expect(calls()).toEqual([
      ['-L', 'orc-cockpit', '-f', '/dev/null', 'kill-server'],
      ['-L', 'orc-cockpit2', '-f', '/dev/null', 'kill-server'],
    ]);
  });

  it('removes the old lock a dead cockpit left, and asks a running old cockpit to exit through it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-retire-old-cockpit-'));
    const { tmux } = fakeTmux();
    const lockPath = oldCockpitLockPath(dir);
    expect(lockPath).toBe(join(dir, 'cockpit', 'cockpit2.lock'));
    mkdirSync(join(dir, 'cockpit'), { recursive: true });

    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, start: 'proc:0' }));
    await retireOldCockpit(dir, tmux);
    expect(existsSync(lockPath)).toBe(false);

    // An old cockpit still running: a child holding the lock that exits when woken, as the old cockpit does on an exit request.
    const old = spawn(process.execPath, ['-e', `process.on('SIGUSR2', () => { require('node:fs').unlinkSync(${JSON.stringify(lockPath)}); process.exit(0); }); setInterval(() => {}, 1000); console.log('ready');`], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise((resolve) => old.stdout.once('data', resolve));
      writeFileSync(lockPath, JSON.stringify({ pid: old.pid, start: readProcessStart(old.pid!) }));
      await retireOldCockpit(dir, tmux);
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(`${lockPath}.exit`)).toBe(false);
      await new Promise((resolve) => (old.exitCode !== null ? resolve(null) : old.once('exit', resolve)));
      expect(old.exitCode).toBe(0);
    } finally {
      old.kill();
    }
  });
});

describe('explorerCommand', () => {
  it('runs orc cockpit explorer for the project, without the launching project\'s selection', () => {
    expect(explorerCommand(['/usr/bin/node', '/orc/cli/orc.js'], 'demo'))
      .toBe("unset ORC_PROJECT_ID ORC_STATE_DIR ORC_CONTROL_SOCKET ORC_PROJECT_FLAG; '/usr/bin/node' '/orc/cli/orc.js' 'cockpit' 'explorer' '--project=demo'");
  });
});

describe('cockpitTheme', () => {
  const resolve = (env: Record<string, string | undefined>, files: Record<string, string> = {}) => {
    const read: string[] = [];
    const { theme, problems } = cockpitTheme(env, (path) => { read.push(path); return files[path] ?? null; });
    return { theme, warnings: problems, read };
  };

  it('draws in orc with no setting, in a named built-in theme, and in mono under NO_COLOR', () => {
    expect(resolve({})).toEqual({ theme: BUILT_IN_THEMES.orc, warnings: [], read: [] });
    expect(resolve({ ORC_COCKPIT_THEME: 'classic' })).toEqual({ theme: BUILT_IN_THEMES.classic, warnings: [], read: [] });
    expect(resolve({ NO_COLOR: '1', ORC_COCKPIT_THEME: 'classic' })).toEqual({ theme: BUILT_IN_THEMES.mono, warnings: [], read: [] });
  });

  it('reads a theme file through the reader it is given', () => {
    const { theme, warnings, read } = resolve(
      { ORC_COCKPIT_THEME: '/themes/violet.json' },
      { '/themes/violet.json': '{ "base": "amber", "roles": { "chrome.border": { "fg": "#7c3aed" } } }' },
    );
    expect(read).toEqual(['/themes/violet.json']);
    expect(warnings).toEqual([]);
    expect(theme.roles['chrome.border'].fg).toEqual({ type: 'rgb', r: 0x7c, g: 0x3a, b: 0xed });
    expect(theme.roles['chrome.title']).toEqual(BUILT_IN_THEMES.amber.roles['chrome.title']);
  });

  it('warns about an unreadable or invalid theme file and draws in orc', () => {
    const missing = resolve({ ORC_COCKPIT_THEME: '/no/such.json' });
    expect(missing.theme).toBe(BUILT_IN_THEMES.orc);
    expect(missing.warnings).toEqual([expect.stringMatching(/^ORC_COCKPIT_THEME: '\/no\/such\.json' is not a built-in theme .* or a readable file; using orc$/)]);
    const broken = resolve({ ORC_COCKPIT_THEME: '/t.json' }, { '/t.json': '{ nope' });
    expect(broken.theme).toBe(BUILT_IN_THEMES.orc);
    expect(broken.warnings).toEqual([expect.stringMatching(/^ORC_COCKPIT_THEME: \/t\.json is not valid JSON/)]);
  });

  it('warns once per bad role and keeps the rest of the file', () => {
    const { theme, warnings } = resolve(
      { ORC_COCKPIT_THEME: '/t.json' },
      { '/t.json': '{ "roles": { "chrome.nope": {}, "chrome.border": { "fg": "red" }, "text.muted": { "bold": true } } }' },
    );
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) expect(warning).toMatch(/^ORC_COCKPIT_THEME \/t\.json: /);
    expect(theme.roles['chrome.border']).toEqual(BUILT_IN_THEMES.orc.roles['chrome.border']);
    expect(theme.roles['text.muted']).toEqual({ ...BUILT_IN_THEMES.orc.roles['text.muted'], bold: true });
  });

  it('reads a missing file as null', () => {
    expect(readTextOrNull(join(tmpdir(), 'orc-cockpit-theme-that-does-not-exist.json'))).toBeNull();
  });
});

describe('cockpitOpeningHint', () => {
  it('names the sidebar and quit keys', () => {
    expect(cockpitOpeningHint(DEFAULT_COCKPIT_KEYS)).toBe('F10: sidebar · Ctrl-q: quit · F12 d: quit');
  });
});

describe('addToCockpit', () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('adds the project as the active one and wakes the running cockpit; with none running it only adds', async () => {
    home = mkdtempSync(join(tmpdir(), 'orc-cockpit-add-'));
    const { lockPath, viewStatePath, viewStateLockPath } = cockpitPaths(home);
    const store = createViewStateStore({ path: viewStatePath, lockPath: viewStateLockPath });

    expect(await addToCockpit('first', home)).toBeNull();
    expect(store.load().tabs).toEqual({ activeProject: 'first', projects: [{ projectId: 'first', tabs: [], active: null }] });

    // This process plays the running cockpit: it holds the lock and receives the wake-up.
    mkdirSync(join(home, 'cockpit'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, start: readProcessStart(process.pid) }));
    let woken = 0;
    const onWake = () => { woken++; };
    process.on('SIGUSR2', onWake);
    try {
      expect(await addToCockpit('second', home)).toEqual({ pid: process.pid, start: readProcessStart(process.pid) });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(woken).toBe(1);
    } finally {
      process.off('SIGUSR2', onWake);
    }
    expect(store.load().tabs.activeProject).toBe('second');
    expect(store.load().tabs.projects.map((project) => project.projectId)).toEqual(['first', 'second']);

    // A lock left by a process that is gone (another start time) is no running cockpit.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, start: 'proc:0' }));
    expect(await addToCockpit('third', home)).toBeNull();
  });

  it('a launch from inside orc\'s tmux servers adds the project instead of running a cockpit', async () => {
    home = mkdtempSync(join(tmpdir(), 'orc-cockpit-add-'));
    const env = { TMUX: `${join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`)}/orc-0123456789ab,1,0` };
    const launch = await launchCockpit({ projectId: 'nested', keys: DEFAULT_COCKPIT_KEYS, theme: BUILT_IN_THEMES.amber, dataHome: home, env });
    expect(launch).toEqual({ kind: 'added', running: null });
    const { viewStatePath, viewStateLockPath } = cockpitPaths(home);
    expect(createViewStateStore({ path: viewStatePath, lockPath: viewStateLockPath }).load().tabs.activeProject).toBe('nested');
  });
});

describe('registrySettingsHost', () => {
  let temp: string;
  let registry: ProjectRegistry;
  let projectId: string;
  afterEach(() => {
    registry?.close();
    if (temp) rmSync(temp, { recursive: true, force: true });
  });
  function setup(run?: RunCommand) {
    temp = mkdtempSync(join(tmpdir(), 'orc-cockpit-settings-'));
    registry = new ProjectRegistry(join(temp, 'data'));
    const root = join(temp, 'repo');
    mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    projectId = registry.add(root).id;
    return registrySettingsHost(['/bin/node', '/orc/cli/orc.ts'], registry, run);
  }

  it('reads the effective settings (global under project) and writes project-scope settings, a number as a number', () => {
    const host = setup();
    registry.setSetting('worker_pool.max_workers', 1);
    registry.setSetting('coordinator.pr_provider', 'github');
    expect(host.read(projectId)).toMatchObject({ 'worker_pool.max_workers': 1, 'coordinator.pr_provider': 'github' });
    host.write(projectId, 'worker_pool.max_workers', 3);
    host.write(projectId, 'coordinator.merge_strategy', 'pr');
    expect(registry.settings(projectId)).toEqual({ 'worker_pool.max_workers': 3, 'coordinator.merge_strategy': 'pr' });
    expect(registry.settings()).toEqual({ 'worker_pool.max_workers': 1, 'coordinator.pr_provider': 'github' });
    expect(host.read(projectId)).toMatchObject({ 'worker_pool.max_workers': 3, 'coordinator.merge_strategy': 'pr' });
  });

  it('stores null for a PR provider of none, overriding a global one, and rejects what the registry rejects', () => {
    const host = setup();
    registry.setSetting('coordinator.pr_provider', 'github');
    host.write(projectId, 'coordinator.pr_provider', null);
    expect(registry.settings(projectId)).toEqual({ 'coordinator.pr_provider': null });
    expect(host.read(projectId)['coordinator.pr_provider']).toBeNull();
    expect(() => host.write(projectId, 'worker_pool.max_workers', '3')).toThrow('non-negative integer');
    expect(() => host.write(projectId, 'coordinator.merge_strategy', null)).toThrow('non-empty string');
    expect(() => host.write('missing', 'worker_pool.max_workers', 1)).toThrow('not registered');
  });

  it('restarts the coordinator as orc --project=<id> coordinator restart --json without the project environment', async () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const host = setup((file, args, options, callback) => { calls.push({ file, args, env: options.env }); callback(null, '{}', ''); });
    const saved = process.env.ORC_PROJECT_ID;
    process.env.ORC_PROJECT_ID = 'elsewhere';
    try { await host.restartCoordinator(projectId); }
    finally { if (saved === undefined) delete process.env.ORC_PROJECT_ID; else process.env.ORC_PROJECT_ID = saved; }
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('/bin/node');
    expect(calls[0].args).toEqual(['/orc/cli/orc.ts', `--project=${projectId}`, 'coordinator', 'restart', '--json']);
    expect(calls[0].env.ORC_PROJECT_ID).toBeUndefined();
  });

  it('rejects a failed restart with its JSON error message, else stderr\'s last line', async () => {
    const failing = (stdout: string, stderr: string): RunCommand => (_file, _args, _options, callback) => { callback(new Error('Command failed'), stdout, stderr); };
    await expect(setup(failing('{"error":{"code":"x","message":"Coordinator did not start"}}\n', '')).restartCoordinator(projectId)).rejects.toThrow('Coordinator did not start');
    registry.close(); rmSync(temp, { recursive: true, force: true });
    await expect(setup(failing('', 'warning\nError: boom\n')).restartCoordinator(projectId)).rejects.toThrow(/^Error: boom$/);
  });
});

describe('agentActionHost', () => {
  let temp: string;
  let registry: ProjectRegistry;
  let projectId: string;
  afterEach(() => {
    registry?.close();
    if (temp) rmSync(temp, { recursive: true, force: true });
  });
  function setup(run: RunCommand, removeScout: RemoveScout = () => Promise.resolve()) {
    temp = mkdtempSync(join(tmpdir(), 'orc-cockpit-agents-'));
    registry = new ProjectRegistry(join(temp, 'data'));
    const root = join(temp, 'repo');
    mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    projectId = registry.add(root).id;
    return agentActionHost(['/bin/node', '/orc/cli/orc.ts'], registry, run, removeScout);
  }
  const withProjectEnv = async (work: () => Promise<void>) => {
    const saved = process.env.ORC_STATE_DIR;
    process.env.ORC_STATE_DIR = '/elsewhere';
    try { await work(); } finally { if (saved === undefined) delete process.env.ORC_STATE_DIR; else process.env.ORC_STATE_DIR = saved; }
  };

  it('kills a worker as orc --project=<id> task-reset <task> --json without the project environment', async () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const host = setup((file, args, options, callback) => { calls.push({ file, args, env: options.env }); callback(null, '{}', ''); });
    await withProjectEnv(() => host.kill(projectId, 'w1', 'worker', 'feat/one'));
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('/bin/node');
    expect(calls[0].args).toEqual(['/orc/cli/orc.ts', `--project=${projectId}`, 'task-reset', 'feat/one', '--json']);
    expect(calls[0].env.ORC_STATE_DIR).toBeUndefined();
    expect(taskResetCommand(['orc'], 'p1', 'a/b')).toEqual({ file: 'orc', args: ['--project=p1', 'task-reset', 'a/b', '--json'] });
  });

  it('rejects a failed reset with its JSON error message, and a worker without a task', async () => {
    const host = setup((_file, _args, _options, callback) => { callback(new Error('Command failed'), '{"error":{"code":"not_found","message":"Task not found: feat/one"}}\n', ''); });
    await expect(host.kill(projectId, 'w1', 'worker', 'feat/one')).rejects.toThrow('Task not found: feat/one');
    await expect(host.kill(projectId, 'w1', 'worker', null)).rejects.toThrow('w1 has no task to reset');
  });

  it('kills a scout by removing it in the project\'s state directory, without the project environment, and runs no command', async () => {
    const removed: Array<{ stateDir: string; agentId: string; env: NodeJS.ProcessEnv }> = [];
    const calls: string[][] = [];
    const host = setup((_file, args, _options, callback) => { calls.push(args); callback(null, '{}', ''); }, (stateDir, agentId, env) => {
      removed.push({ stateDir, agentId, env });
      return Promise.resolve({ agent_id: agentId, removed: true });
    });
    await withProjectEnv(() => host.kill(projectId, 's1', 'scout', null));
    expect(removed).toEqual([{ stateDir: registry.get(projectId)!.stateDir, agentId: 's1', env: expect.not.objectContaining({ ORC_STATE_DIR: expect.anything() }) as unknown }]);
    expect(calls).toEqual([]);
    await expect(host.kill('missing', 's1', 'scout', null)).rejects.toThrow('Project is not registered: missing');
  });

  it('rejects with why a scout could not be removed', async () => {
    const host = setup((_file, _args, _options, callback) => { callback(null, '{}', ''); }, () => Promise.reject(new Error('Only a master session that is not offline may act as master')));
    await expect(host.kill(projectId, 's1', 'scout', null)).rejects.toThrow('Only a master session');
  });
});

describe('coordinatorRestartCommand and commandFailure', () => {
  it('builds the restart command from the orc command', () => {
    expect(coordinatorRestartCommand(['orc'], 'p1')).toEqual({ file: 'orc', args: ['--project=p1', 'coordinator', 'restart', '--json'] });
  });

  it('prefers the JSON error, then stderr\'s last line, then the error', () => {
    const error = new Error('Command failed: orc');
    expect(commandFailure(error, '{"error":{"message":"nope"}}', 'Error: other')).toBe('nope');
    expect(commandFailure(error, 'not json', 'a\nError: other\n')).toBe('Error: other');
    expect(commandFailure(error, '{"ok":true}', '')).toBe('Command failed: orc');
  });
});

describe('projectAddHost', () => {
  const orc = ['/bin/node', '/orc/cli/orc.ts'];

  it('runs orc project add <path> [--name] then orc --project=<id> init --provider, without the project environment', async () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run: RunCommand = (file, args, options, callback) => {
      calls.push({ file, args, env: options.env });
      callback(null, args.includes('add') ? '{"id":"p-1","name":"app","canonicalGitRoot":"/work/app"}\n' : 'Project app (p-1) configured\n', '');
    };
    const saved = process.env.ORC_PROJECT_ID;
    process.env.ORC_PROJECT_ID = 'elsewhere';
    try {
      expect(await projectAddHost(orc, run).add('/work/app', 'My App', 'codex')).toEqual({ projectId: 'p-1' });
      expect(await projectAddHost(orc, run).add('/work/app', null, 'claude')).toEqual({ projectId: 'p-1' });
    } finally { if (saved === undefined) delete process.env.ORC_PROJECT_ID; else process.env.ORC_PROJECT_ID = saved; }
    expect(calls.map((call) => [call.file, ...call.args])).toEqual([
      ['/bin/node', '/orc/cli/orc.ts', 'project', 'add', '/work/app', '--name=My App'],
      ['/bin/node', '/orc/cli/orc.ts', '--project=p-1', 'init', '--provider=codex'],
      ['/bin/node', '/orc/cli/orc.ts', 'project', 'add', '/work/app'],
      ['/bin/node', '/orc/cli/orc.ts', '--project=p-1', 'init', '--provider=claude'],
    ]);
    expect(calls.every((call) => call.env.ORC_PROJECT_ID === undefined)).toBe(true);
  });

  it('rejects with the failing command\'s stderr, and says when the project was added but init failed', async () => {
    const addFails: RunCommand = (_file, _args, _options, callback) => { callback(new Error('Command failed'), '', 'Not a git repository: /nope\n'); };
    await expect(projectAddHost(orc, addFails).add('/nope', null, 'claude')).rejects.toThrow(/^Not a git repository: \/nope$/);
    const initFails: RunCommand = (_file, args, _options, callback) => {
      if (args.includes('add')) callback(null, '{"id":"p-1"}', '');
      else callback(new Error('Command failed'), '', 'Error: bad provider\n');
    };
    await expect(projectAddHost(orc, initFails).add('/work/app', null, 'claude')).rejects.toThrow('The project was added but not configured (orc init): Error: bad provider');
  });
});

describe('readAgentDefinitions', () => {
  let temp: string;
  afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

  it('reads .claude/agents/*.md: frontmatter name (else the file name) and description, the body as the prompt', () => {
    temp = mkdtempSync(join(tmpdir(), 'orc-cockpit-agents-'));
    expect(readAgentDefinitions(temp)).toEqual([]);
    const dir = join(temp, '.claude', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'critic.md'), '---\nname: critic\ndescription: "Reviews: bugs and regressions"\ntools: Read, Grep\n---\n\nYou are the critic.\nReview it.\n');
    writeFileSync(join(dir, 'plain.md'), 'Just a prompt.\n');
    writeFileSync(join(dir, 'empty.md'), '---\nname: empty\n---\n\n');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    expect(readAgentDefinitions(temp)).toEqual([
      { name: 'critic', description: 'Reviews: bugs and regressions', prompt: 'You are the critic.\nReview it.' },
      { name: 'plain', description: '', prompt: 'Just a prompt.' },
    ]);
  });
});
