import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveActiveProject } from './projectContext.ts';
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
