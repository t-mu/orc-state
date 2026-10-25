import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRegistry, canonicalProjectGitRoot, projectDataHome, validateProjectSetting } from './projectRegistry.ts';

let temp: string;
let registry: ProjectRegistry;

function gitRepo(name: string): string {
  const root = join(temp, name);
  mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  return realpathSync(root);
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'orc-registry-'));
  registry = new ProjectRegistry(join(temp, 'data'));
});

afterEach(() => {
  registry.close();
  rmSync(temp, { recursive: true, force: true });
});

describe('global project registry', () => {
  it('uses an overridable data home and keeps registry and state outside the target repo', () => {
    expect(projectDataHome({ ORC_DATA_HOME: join(temp, 'custom') })).toBe(resolve(temp, 'custom'));
    expect(() => projectDataHome({ ORC_DATA_HOME: '' })).toThrow('non-empty');
    const root = gitRepo('product');
    const project = registry.add(root);
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.stateDir).toBe(join(temp, 'data', 'projects', project.id));
    expect(registry.list()).toEqual([project]);
    expect(() => registry.add(root)).toThrow('already registered');
  });

  it('canonicalizes symlinks and linked worktrees to one project root', () => {
    const root = gitRepo('product');
    writeFileSync(join(root, 'README.md'), 'test');
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial']);
    const alias = join(temp, 'alias');
    symlinkSync(root, alias);
    expect(canonicalProjectGitRoot(alias)).toBe(root);
    const worktree = join(temp, 'worker');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', 'worker', worktree]);
    expect(canonicalProjectGitRoot(worktree)).toBe(root);
    const project = registry.add(root);
    expect(registry.resolve({ cwd: worktree, env: {} })).toEqual(project);
  });

  it('registers the working tree when Git metadata is stored separately', () => {
    const root = join(temp, 'product');
    execFileSync('git', ['init', '-q', `--separate-git-dir=${join(temp, 'metadata.git')}`, root]);
    expect(canonicalProjectGitRoot(root)).toBe(realpathSync(root));
    expect(registry.add(root).canonicalGitRoot).toBe(realpathSync(root));
  });

  it('does not persist a project if its external state directory cannot be created', () => {
    const root = gitRepo('product');
    writeFileSync(join(temp, 'data', 'projects'), 'not a directory');
    expect(() => registry.add(root)).toThrow();
    expect(registry.list()).toEqual([]);
  });

  it('applies explicit, environment, cwd, then outside-repo selection and rejects unknown ids', () => {
    const a = registry.add(gitRepo('a'));
    const b = registry.add(gitRepo('b'));
    registry.select(b.id);
    expect(registry.resolve({ explicitProjectId: b.id, env: { ORC_PROJECT_ID: a.id }, cwd: a.canonicalGitRoot })).toEqual(b);
    expect(registry.resolve({ env: { ORC_PROJECT_ID: b.id }, cwd: a.canonicalGitRoot })).toEqual(b);
    expect(registry.resolve({ env: {}, cwd: a.canonicalGitRoot })).toEqual(a);
    expect(registry.resolve({ env: {}, cwd: temp })).toEqual(b);
    expect(() => registry.resolve({ env: { ORC_PROJECT_ID: 'missing' }, cwd: a.canonicalGitRoot })).toThrow('not uniquely registered');
    expect(() => registry.resolve({ env: {}, cwd: gitRepo('unregistered') })).toThrow('not registered');
    registry.close();
    registry = new ProjectRegistry(join(temp, 'data'));
    expect(registry.selectedId()).toBe(b.id);
  });

  it('stores validated non-secret settings and resolves CLI > env > project > global', () => {
    const project = registry.add(gitRepo('product'));
    registry.setSetting('worker_pool.max_workers', 1);
    registry.setSetting('worker_pool.max_workers', 2, project.id);
    registry.setSetting('worker_pool.provider', 'codex');
    registry.setSetting('worker_pool.provider', 'claude', project.id);
    expect(registry.effectiveSettings(project.id, {}, { ORC_MAX_WORKERS: '3' })).toMatchObject({
      'worker_pool.max_workers': 3,
      'worker_pool.provider': 'claude',
    });
    expect(registry.effectiveSettings(project.id, { 'worker_pool.max_workers': 4 }, { ORC_MAX_WORKERS: '3' })['worker_pool.max_workers']).toBe(4);
    registry.close();
    registry = new ProjectRegistry(join(temp, 'data'));
    expect(registry.settings(project.id)['worker_pool.provider']).toBe('claude');
    registry.unsetSetting('worker_pool.provider', project.id);
    expect(registry.effectiveSettings(project.id)['worker_pool.provider']).toBe('codex');
    expect(() => registry.setSetting('provider_token', 'secret')).toThrow('Unknown or secret-bearing');
    expect(() => registry.setSetting('coordinator.pr_push_remote', 'https://x-access-token:ghp_abc@github.com/o/r.git')).toThrow('must not embed credentials');
    expect(() => registry.setSetting('coordinator.pr_push_remote', 'git@github.com:o/r.git')).not.toThrow();
    expect(() => registry.setSetting('coordinator.pr_push_remote', 'ssh://git@github.com/o/r.git')).not.toThrow();
    expect(() => registry.setSetting('coordinator.pr_push_remote', 'https://ghp_abc@github.com/o/r.git')).toThrow('must not embed credentials');
    expect(() => registry.setSetting('worker_pool.max_workers', -1)).toThrow('non-negative');
    expect(() => validateProjectSetting('master.provider', 'unknown')).toThrow('Invalid');
  });

  it('exposes registration and configuration through orc project without a repo-local config file', () => {
    const root = gitRepo('product');
    const env = { ...process.env, ORC_DATA_HOME: join(temp, 'cli-data') };
    const cli = resolve(import.meta.dirname, '..', 'cli', 'orc.ts');
    const add = spawnSync(process.execPath, [cli, 'project', 'add', root], { cwd: temp, env, encoding: 'utf8' });
    expect(add.status, add.stderr).toBe(0);
    const project = JSON.parse(add.stdout) as { id: string };
    const list = spawnSync(process.execPath, [cli, 'project', 'list'], { cwd: temp, env, encoding: 'utf8' });
    expect(JSON.parse(list.stdout)).toHaveLength(1);
    const select = spawnSync(process.execPath, [cli, 'project', 'select', project.id], { cwd: temp, env, encoding: 'utf8' });
    expect(select.status, select.stderr).toBe(0);
    const set = spawnSync(process.execPath, [cli, 'project', 'config', 'set', 'worker_pool.max_workers', '2', `--project=${project.id}`], { cwd: temp, env, encoding: 'utf8' });
    expect(set.status, set.stderr).toBe(0);
    const show = spawnSync(process.execPath, [cli, 'project', 'show', `--project=${project.id}`], { cwd: temp, env, encoding: 'utf8' });
    expect(JSON.parse(show.stdout).id).toBe(project.id);
    const get = spawnSync(process.execPath, [cli, 'project', 'config', 'get', 'worker_pool.max_workers', `--project=${project.id}`], { cwd: temp, env, encoding: 'utf8' });
    expect(JSON.parse(get.stdout).value).toBe(2);
    const configList = spawnSync(process.execPath, [cli, 'project', 'config', 'list'], { cwd: temp, env, encoding: 'utf8' });
    expect(JSON.parse(configList.stdout)['worker_pool.max_workers']).toBe(2);
    const unset = spawnSync(process.execPath, [cli, 'project', 'config', 'unset', 'worker_pool.max_workers'], { cwd: temp, env, encoding: 'utf8' });
    expect(unset.status, unset.stderr).toBe(0);
    const globalSet = spawnSync(process.execPath, [cli, 'project', 'config', 'set', 'worker_pool.max_workers', '1', '--global'], { cwd: temp, env, encoding: 'utf8' });
    expect(globalSet.status, globalSet.stderr).toBe(0);
    const fallback = spawnSync(process.execPath, [cli, 'project', 'config', 'get', 'worker_pool.max_workers'], { cwd: temp, env, encoding: 'utf8' });
    expect(JSON.parse(fallback.stdout).value).toBe(1);
  });
});
