import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-init-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

function run(args: string[] = []) {
  return spawnSync('node', ['cli/init.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: join(dir, 'state') },
    encoding: 'utf8',
  });
}

describe('cli/init.ts', () => {
  it('creates all four state files', () => {
    const result = run();
    expect(result.status).toBe(0);
    const stateDir = join(dir, 'state');
    expect(existsSync(join(stateDir, 'backlog.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'agents.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'claims.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'events.db'))).toBe(true);
  });

  it('creates default feature when not provided', () => {
    const result = run();
    expect(result.status).toBe(0);
    const backlog = JSON.parse(readFileSync(join(dir, 'state', 'backlog.json'), 'utf8'));
    expect(backlog.features).toHaveLength(1);
    expect(backlog.features[0].ref).toBe('project');
  });

  it('creates custom feature ref and title', () => {
    const result = run(['--feature=my-app', '--feature-title=My App']);
    expect(result.status).toBe(0);
    const backlog = JSON.parse(readFileSync(join(dir, 'state', 'backlog.json'), 'utf8'));
    expect(backlog.features[0].ref).toBe('my-app');
    expect(backlog.features[0].title).toBe('My App');
  });

  it('fails without --force when files already exist', () => {
    expect(run().status).toBe(0);
    const second = run();
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already contains');
  });

  it('backs up files and overwrites when --force is used', () => {
    expect(run().status).toBe(0);

    const result = run(['--force']);
    expect(result.status).toBe(0);
    const stateDir = join(dir, 'state');
    expect(existsSync(join(stateDir, 'backlog.json.bak'))).toBe(true);
    expect(existsSync(join(stateDir, 'agents.json.bak'))).toBe(true);
    expect(existsSync(join(stateDir, 'claims.json.bak'))).toBe(true);
    expect(existsSync(join(stateDir, 'events.db.bak'))).toBe(true);
  });
});
