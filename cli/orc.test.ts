import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

describe('cli/orc.ts', () => {
  it('groups blessed workflow, recovery/debug, inspection, and specialized commands in help output', () => {
    const result = spawnSync('node', ['--experimental-strip-types', 'cli/orc.ts', '--help'], {
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
    expect(result.stdout).toContain('master-check');
    expect(result.stdout.indexOf('Blessed workflow commands:')).toBeLessThan(result.stdout.indexOf('Recovery / debug commands:'));
    expect(result.stdout.indexOf('Recovery / debug commands:')).toBeLessThan(result.stdout.indexOf('Supported inspection commands:'));
    expect(result.stdout.indexOf('Supported inspection commands:')).toBeLessThan(result.stdout.indexOf('Advanced / specialized commands:'));
  });

  it('dispatches documented inspection commands', () => {
    const result = spawnSync('node', ['--experimental-strip-types', 'cli/orc.ts', 'master-check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
  });
});
