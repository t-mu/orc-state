import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { createTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { buildNodeArgs, isMainModule } from './orc.ts';

const repoRoot = resolve(import.meta.dirname, '..');

describe('cli/orc.ts', () => {
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
    expect(result.stdout).toContain('task-create');
    expect(result.stdout).toContain('register-worker');
    expect(result.stdout).toContain('events-tail');
    expect(result.stdout).toContain('install-agents');
    expect(result.stdout.indexOf('Blessed workflow commands:')).toBeLessThan(result.stdout.indexOf('Recovery / debug commands:'));
    expect(result.stdout.indexOf('Recovery / debug commands:')).toBeLessThan(result.stdout.indexOf('Supported inspection commands:'));
    expect(result.stdout.indexOf('Supported inspection commands:')).toBeLessThan(result.stdout.indexOf('Advanced / specialized commands:'));
  });

  it('dispatches documented inspection commands', () => {
    const result = spawnSync('node', ['cli/orc.ts', 'events-tail'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
  });

  it('dispatches watch with tsx/esm', () => {
    expect(buildNodeArgs('watch', '/tmp/watch.ts', ['--once'])).toEqual([
      '--import',
      'tsx/esm',
      '/tmp/watch.ts',
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
