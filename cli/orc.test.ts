import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { bridgeProjectEnv, cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { buildNodeArgs, childEnv, COMMANDS, isMainModule, readVersion } from './orc.ts';
import { USAGE, wantsHelp } from './usage.ts';

const repoRoot = resolve(import.meta.dirname, '..');

describe('cli/orc.ts', () => {
  it('marks --project as the selector in the child env and drops an inherited marker otherwise', () => {
    const inherited = { PATH: '/bin', ORC_PROJECT_ID: 'a', ORC_STATE_DIR: '/state/a', ORC_PROJECT_FLAG: 'a' };
    expect(childEnv(inherited, 'b')).toEqual({ PATH: '/bin', ORC_PROJECT_ID: 'b', ORC_PROJECT_FLAG: 'b', ORC_STATE_DIR: '' });
    expect(childEnv(inherited, null)).toEqual({ PATH: '/bin', ORC_PROJECT_ID: 'a', ORC_STATE_DIR: '/state/a' });
  });

  it('has a usage synopsis for every subcommand', () => {
    expect(Object.keys(USAGE).sort()).toEqual(Object.keys(COMMANDS).sort());
  });

  it('prints usage for <subcommand> --help without running the command', () => {
    for (const subcommand of ['kill-all', 'worker-gc', 'start-session', 'install-agents', 'worker-remove']) {
      const result = spawnSync('node', ['cli/orc.ts', subcommand, '--help'], {
        cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ORC_STATE_DIR: '/nonexistent-orc-help-test' },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Usage: orc ${subcommand}`);
    }
  });

  it('prints usage from cli/usage.ts only (no second copy in a command)', () => {
    for (const file of new Set(Object.values(COMMANDS))) {
      const code = readFileSync(join(repoRoot, 'cli', file), 'utf8').split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line));
      expect(code.filter((line) => /['"`]Usage: orc /.test(line)), file).toEqual([]);
    }
  });

  it('treats --help after a -- separator as an argument', () => {
    expect(wantsHelp(['--', '--help'])).toBe(false);
    expect(wantsHelp(['x', '-h'])).toBe(true);
  });

  it('groups blessed workflow, recovery/debug, inspection, and specialized commands in help output', () => {
    const result = spawnSync('node', ['cli/orc.ts', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Blessed workflow commands:');
    expect(result.stdout).toContain('Recovery / debug commands:');
    expect(result.stdout).toContain('Supported inspection commands:');
    expect(result.stdout).toContain('Advanced / specialized commands:');
    expect(result.stdout).toContain('start-session');
    expect(result.stdout).toContain('task-mark-done');
    expect(result.stdout).not.toContain('task-create');
    expect(result.stdout).toContain('worker-gc');
    expect(result.stdout).not.toMatch(/register-worker|start-worker-session|deregister|worker-clearall/);
    expect(result.stdout).toMatch(/^\s+events$/m);
    expect(result.stdout).toContain('install-agents');
    expect(result.stdout.indexOf('Blessed workflow commands:')).toBeLessThan(result.stdout.indexOf('Recovery / debug commands:'));
    expect(result.stdout.indexOf('Recovery / debug commands:')).toBeLessThan(result.stdout.indexOf('Supported inspection commands:'));
    expect(result.stdout.indexOf('Supported inspection commands:')).toBeLessThan(result.stdout.indexOf('Advanced / specialized commands:'));
    // The blessed set is what AGENTS.md tells agents to use; coordinator-only and Markdown commands are not in it.
    const section = (title: string) => result.stdout.split(`${title}\n`)[1].split('\n\n')[0].split('\n').map((line) => line.trim());
    expect(section('Blessed workflow commands:')).toEqual(expect.arrayContaining(['project', 'progress', 'review-submit', 'review-read', 'run-input-request']));
    expect(section('Blessed workflow commands:')).not.toContain('task-mark-done');
    expect(section('Recovery / debug commands:')).toContain('task-mark-done');
    expect(result.stdout).not.toMatch(/backlog-sync|backlog-orient|feature-create/);
  });

  it('prints the package version for --version and -v', () => {
    const expectedVersion = readVersion();

    const longFlag = spawnSync('node', ['cli/orc.ts', '--version'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const shortFlag = spawnSync('node', ['cli/orc.ts', '-v'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(longFlag.status).toBe(0);
    expect(shortFlag.status).toBe(0);
    expect(longFlag.stdout.trim()).toBe(expectedVersion);
    expect(shortFlag.stdout.trim()).toBe(expectedVersion);
  });

  it('dispatches documented inspection commands', () => {
    const stateDir = createTempStateDir('orc-dispatch-');
    const result = spawnSync('node', ['cli/orc.ts', 'events'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...bridgeProjectEnv(stateDir) },
    });
    cleanupTempStateDir(stateDir);

    expect(result.status).toBe(0);
  });

  it('dispatches watch with tsx/esm from orc\'s own install when running from source', () => {
    const args = buildNodeArgs('watch', '/tmp/watch.ts', ['--once']);
    expect(args[0]).toBe('--import');
    // An absolute URL, so a caller's cwd (a project's target repository) never has to provide tsx.
    expect(args[1]).toMatch(/^file:\/\/.*\/node_modules\/tsx\//);
    expect(args.slice(2)).toEqual(['/tmp/watch.ts', '--once']);
  });

  it('dispatches watch without tsx/esm when running compiled', () => {
    expect(buildNodeArgs('watch', '/tmp/watch.js', ['--once'])).toEqual([
      '/tmp/watch.js',
      '--once',
    ]);
  });

  it('passes script path directly for non-watch commands', () => {
    expect(buildNodeArgs('status', '/tmp/status.ts', ['--json'])).toEqual([
      '/tmp/status.ts',
      '--json',
    ]);
  });

  it('treats symlinked entrypoints as the main module', () => {
    const tempDir = createTempStateDir('orc-main-');
    const symlinkPath = join(tempDir, 'orc.ts');
    symlinkSync(resolve(repoRoot, 'cli/orc.ts'), symlinkPath);

    expect(isMainModule(symlinkPath, new URL('./orc.ts', import.meta.url).href)).toBe(true);
  });

  it('prints help when invoked through a symlinked path', () => {
    const tempDir = createTempStateDir('orc-cli-');
    const symlinkPath = join(tempDir, 'orc.ts');
    symlinkSync(resolve(repoRoot, 'cli/orc.ts'), symlinkPath);

    const result = spawnSync('node', [symlinkPath, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: orc <subcommand> [args...]');
  });
});
