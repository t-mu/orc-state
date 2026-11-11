import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_COCKPIT_KEYS } from '../lib/cockpitKeys.ts';
import { readProcessStart } from '../lib/processIdentity.ts';
import { addToCockpit, cockpit2KeysHint, cockpit2Paths, cockpitLaunch, insideOrcTmux, killOldCockpit, launchCockpit2 } from './cockpit2.ts';
import { createViewStateStore } from '../lib/cockpit2/viewState.ts';

describe('cockpit2Paths', () => {
  it('keeps the cockpit lock and the view state under orc\'s data home', () => {
    expect(cockpit2Paths('/home/u/.local/share/orc-state')).toEqual({
      lockPath: '/home/u/.local/share/orc-state/cockpit/cockpit2.lock',
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

describe('killOldCockpit', () => {
  it('kills only the tmux-pane cockpit\'s server, without reading a tmux config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-kill-old-cockpit-'));
    try {
      const tmux = join(dir, 'tmux');
      writeFileSync(tmux, `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(dir, 'args')}'\nexit 1\n`);
      chmodSync(tmux, 0o755);
      // tmux exits 1 when no such server runs: that is not an error.
      expect(() => killOldCockpit(tmux)).not.toThrow();
      expect(readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')).toEqual(['-L', 'orc-cockpit', '-f', '/dev/null', 'kill-server']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cockpit2KeysHint', () => {
  it('names the sidebar and quit keys', () => {
    expect(cockpit2KeysHint(DEFAULT_COCKPIT_KEYS)).toBe('F10: sidebar · Ctrl-q: quit · F12 d: quit');
  });
});

describe('addToCockpit', () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('adds the project as the active one and wakes the running cockpit; with none running it only adds', async () => {
    home = mkdtempSync(join(tmpdir(), 'orc-cockpit2-add-'));
    const { lockPath, viewStatePath, viewStateLockPath } = cockpit2Paths(home);
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
    home = mkdtempSync(join(tmpdir(), 'orc-cockpit2-add-'));
    const env = { TMUX: `${join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`)}/orc-0123456789ab,1,0` };
    const launch = await launchCockpit2({ projectId: 'nested', keys: DEFAULT_COCKPIT_KEYS, dataHome: home, env });
    expect(launch).toEqual({ kind: 'added', running: null });
    const { viewStatePath, viewStateLockPath } = cockpit2Paths(home);
    expect(createViewStateStore({ path: viewStatePath, lockPath: viewStateLockPath }).load().tabs.activeProject).toBe('nested');
  });
});
