import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');

describe('cli/run-heartbeat.ts', () => {
  it('exits 0 with deprecation warning', () => {
    const result = spawnSync('node', ['cli/run-heartbeat.ts', '--run-id=run-1', '--agent-id=worker-1'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('deprecated');
  });

  it('exits 0 even with no arguments (backward compatible)', () => {
    const result = spawnSync('node', ['cli/run-heartbeat.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('deprecated');
  });
});
