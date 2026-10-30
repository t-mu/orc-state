import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
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

// Run init in a fresh orchestration cwd with the ambient ORC_* path overrides
// cleared, so state/backlog/plans/config resolve under that cwd (as they would
// for a real `orc init` in a new directory).
function runSibling(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.ORC_STATE_DIR;
  delete env.ORC_REPO_ROOT;
  delete env.ORC_HOME;
  return spawnSync('node', [resolve(repoRoot, 'cli/init.ts'), ...args], { cwd, env, encoding: 'utf8' });
}

describe('cli/init.ts outside a registered project', () => {
  it('refuses a legacy installation and writes nothing', () => {
    const orch = join(dir, 'orch');
    mkdirSync(orch, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: orch });
    const result = runSibling(orch, ['--provider=claude']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Legacy .orc-state installations no longer run');
    expect(result.stderr).toContain('orc project add');
    expect(existsSync(join(orch, 'orc-state.config.json'))).toBe(false);
    expect(existsSync(join(orch, '.orc-state'))).toBe(false);
    expect(existsSync(join(orch, 'backlog'))).toBe(false);
  });
});

describe('cli/init.ts --sibling', () => {
  it('is retired and points at project registration, writing nothing', () => {
    const orch = join(dir, 'orch');
    mkdirSync(orch, { recursive: true });
    const result = runSibling(orch, ['--sibling=../target', '--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('orc init --sibling is retired');
    expect(result.stderr).toContain('orc project add');
    expect(existsSync(join(orch, 'orc-state.config.json'))).toBe(false);
    expect(existsSync(join(orch, '.orc-state'))).toBe(false);
  });
});

describe('cli/init.ts in a registered project', () => {
  it('records settings in the registry, completes the external state and writes nothing into the target', () => {
    const target = join(dir, 'product');
    mkdirSync(target, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: target });
    const env: NodeJS.ProcessEnv = { ...process.env, ORC_DATA_HOME: join(dir, 'data') };
    for (const key of ['ORC_STATE_DIR', 'ORC_REPO_ROOT', 'ORC_HOME', 'ORC_CONFIG_FILE', 'ORC_PROJECT_ID']) delete env[key];
    const added = spawnSync('node', [resolve(repoRoot, 'cli/orc.ts'), 'project', 'add', target, '--name=demo'], { cwd: dir, env, encoding: 'utf8' });
    expect(added.status, added.stderr).toBe(0);
    const project = JSON.parse(added.stdout) as { id: string; stateDir: string };

    const result = spawnSync('node', [resolve(repoRoot, 'cli/init.ts'), '--provider=claude,codex'], { cwd: target, env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Nothing was written into the target repository');
    expect(spawnSync('ls', ['-A', target], { encoding: 'utf8' }).stdout.trim()).toBe('.git');
    const settings = spawnSync('node', [resolve(repoRoot, 'cli/orc.ts'), 'project', 'config', 'list'], { cwd: target, env, encoding: 'utf8' });
    expect(JSON.parse(settings.stdout)).toMatchObject({ default_provider: 'claude', 'worker_pool.provider': 'codex', 'worker_pool.max_workers': 1 });
    expect(existsSync(join(project.stateDir, 'runtime.db'))).toBe(true);

    // Selected with --project from outside any checkout: no Git check in the cwd; repo-install options are noted as ignored.
    const outside = spawnSync('node', [resolve(repoRoot, 'cli/orc.ts'), `--project=${project.id}`, 'init', '--provider=claude', '--skip-mcp'], { cwd: dir, env, encoding: 'utf8' });
    expect(outside.status, outside.stderr).toBe(0);
    expect(outside.stderr).toContain('--skip-mcp has no effect in a registered project');

    const forced = spawnSync('node', [resolve(repoRoot, 'cli/init.ts'), '--provider=claude', '--force'], { cwd: target, env, encoding: 'utf8' });
    expect(forced.status).toBe(1);
    expect(forced.stderr).toContain('would reset the live state of project demo');
  });
});
