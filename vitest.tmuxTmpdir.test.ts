import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup, TMUX_TMPDIR_PREFIX } from './vitest.tmuxTmpdir.mjs';

const REPO_ROOT = import.meta.dirname;
const CONFIGS = ['vitest.config.mjs', 'vitest.e2e.config.mjs', 'vitest.integration.config.mjs', 'vitest.real-providers.config.mjs'];
const GLOBAL_SETUP = resolve(REPO_ROOT, 'vitest.tmuxTmpdir.mjs');
const hasTmux = spawnSync('tmux', ['-V']).status === 0;

describe('vitest runs tmux in a private TMUX_TMPDIR (tmux-socket-leak)', () => {
  it('this test process inherited a throwaway TMUX_TMPDIR, not the real /tmp/tmux-<uid>', () => {
    const dir = process.env.TMUX_TMPDIR;
    expect(dir).toBeTruthy();
    expect(dir!.startsWith(join(tmpdir(), TMUX_TMPDIR_PREFIX))).toBe(true);
    expect(existsSync(dir!)).toBe(true);
  });

  it.each(CONFIGS)('%s registers the TMUX_TMPDIR global setup', async (config) => {
    const loaded = (await import(pathToFileURL(resolve(REPO_ROOT, config)).href)) as { default: { test: { globalSetup?: string[] } } };
    expect(loaded.default.test.globalSetup).toContain(GLOBAL_SETUP);
  });

  it.skipIf(!hasTmux)('teardown kills servers left in the directory and removes it', () => {
    const outer = process.env.TMUX_TMPDIR;
    let teardown: (() => void) | undefined;
    try {
      teardown = setup();
      const dir = process.env.TMUX_TMPDIR!;
      expect(dir).not.toBe(outer);
      expect(spawnSync('tmux', ['-L', 'orc-guard', 'new-session', '-d', 'sleep 60']).status).toBe(0);
      const uidDir = readdirSync(dir).map((name) => join(dir, name));
      expect(uidDir).toHaveLength(1);
      expect(readdirSync(uidDir[0])).toContain('orc-guard');
      const pid = Number(spawnSync('tmux', ['-L', 'orc-guard', 'display-message', '-p', '#{pid}'], { encoding: 'utf8' }).stdout.trim());
      expect(pid).toBeGreaterThan(0);
      teardown();
      teardown = undefined;
      expect(existsSync(dir)).toBe(false);
      // kill-server signals the server; it exits shortly after.
      const deadline = Date.now() + 5_000;
      while (spawnSync('kill', ['-0', String(pid)]).status === 0 && Date.now() < deadline) spawnSync('sleep', ['0.05']);
      expect(spawnSync('kill', ['-0', String(pid)]).status).not.toBe(0);
    } finally {
      teardown?.();
      process.env.TMUX_TMPDIR = outer;
    }
  }, 15_000);
});
