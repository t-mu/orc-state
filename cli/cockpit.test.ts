import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_COCKPIT_KEYS } from '../lib/cockpitKeys.ts';
import { readProcessStart } from '../lib/processIdentity.ts';
import {
  addToCockpit, cockpitLaunch, cockpitTheme, cockpitOpeningHint, cockpitPaths, explorerCommand, insideOrcTmux, launchCockpit, oldCockpitLockPath, readTextOrNull, retireOldCockpit,
} from './cockpit.ts';
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
