import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectConfigObject, resolveActiveProject } from './projectContext.ts';
import { ProjectRegistry } from './projectRegistry.ts';

let temp: string;

function gitRepo(name: string): string {
  const root = join(temp, name);
  mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  return realpathSync(root);
}

beforeEach(() => { temp = realpathSync(mkdtempSync(join(tmpdir(), 'orc-project-context-'))); });
afterEach(() => { rmSync(temp, { recursive: true, force: true }); });

describe('resolveActiveProject', () => {
  it('selects by ORC_PROJECT_ID, then the cwd Git root, then the selected project', () => {
    const registry = new ProjectRegistry(join(temp, 'data'));
    const a = registry.add(gitRepo('a'));
    const b = registry.add(gitRepo('b'));
    registry.select(b.id);
    registry.close();
    const env = { ORC_DATA_HOME: join(temp, 'data') };
    expect(resolveActiveProject({ ...env, ORC_PROJECT_ID: b.id }, a.canonicalGitRoot)).toMatchObject({ id: b.id, source: 'environment' });
    expect(resolveActiveProject(env, a.canonicalGitRoot)).toMatchObject({ id: a.id, source: 'cwd' });
    expect(resolveActiveProject(env, temp)).toMatchObject({ id: b.id, source: 'selected' });
    expect(() => resolveActiveProject({ ...env, ORC_PROJECT_ID: 'nope' }, temp)).toThrow('ORC_PROJECT_ID is not a registered project: nope');
  });

  it('ignores a leftover migration record and legacy files', () => {
    const registry = new ProjectRegistry(join(temp, 'data'));
    const project = registry.add(gitRepo('a'));
    registry.close();
    writeFileSync(join(project.stateDir, 'migration.json'), JSON.stringify({ status: 'importing' }));
    mkdirSync(join(project.canonicalGitRoot, '.orc-state'));
    const env = { ORC_DATA_HOME: join(temp, 'data') };
    expect(resolveActiveProject(env, project.canonicalGitRoot)).toMatchObject({ id: project.id, source: 'cwd' });
    expect(resolveActiveProject({ ...env, ORC_PROJECT_ID: project.id }, temp)).toMatchObject({ id: project.id, source: 'environment' });
  });

  it('fails instead of falling back to the selected project when the cwd repository cannot be read', () => {
    const registry = new ProjectRegistry(join(temp, 'data'));
    const selected = registry.add(gitRepo('a'));
    registry.select(selected.id);
    registry.close();
    const other = gitRepo('b');
    const env = { ORC_DATA_HOME: join(temp, 'data') };
    expect(resolveActiveProject(env, other)).toBeNull();
    expect(resolveActiveProject(env, temp)).toMatchObject({ id: selected.id, source: 'selected' });
    appendFileSync(join(other, '.git', 'config'), '\n[broken\n');
    expect(() => resolveActiveProject(env, other)).toThrow(`Cannot identify the Git repository at ${other} (fatal: `);
  });

  it('recognises "outside Git" under a translated Git locale', () => {
    const registry = new ProjectRegistry(join(temp, 'data'));
    const selected = registry.add(gitRepo('a'));
    registry.select(selected.id);
    registry.close();
    const saved = { LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
    process.env.LC_ALL = 'de_DE.UTF-8';
    process.env.LANGUAGE = 'de';
    try {
      expect(resolveActiveProject({ ORC_DATA_HOME: join(temp, 'data') }, temp)).toMatchObject({ id: selected.id, source: 'selected' });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('projectConfigObject', () => {
  it('nests project settings over global ones, and gives only the global ones without a project', () => {
    const env = { ORC_DATA_HOME: join(temp, 'data') };
    expect(projectConfigObject(null, env)).toEqual({});
    const registry = new ProjectRegistry(join(temp, 'data'));
    const project = registry.add(gitRepo('a'));
    registry.setSetting('worker_pool.max_workers', 1);
    registry.setSetting('worker_pool.provider', 'codex');
    registry.setSetting('worker_pool.max_workers', 2, project.id);
    registry.close();
    const active = resolveActiveProject({ ...env, ORC_PROJECT_ID: project.id }, temp)!;
    expect(projectConfigObject(active, env)).toEqual({ worker_pool: { max_workers: 2, provider: 'codex' } });
    expect(projectConfigObject(null, env)).toEqual({ worker_pool: { max_workers: 1, provider: 'codex' } });
  });
});
