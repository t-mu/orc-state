import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ORC = resolve(import.meta.dirname, 'orc.ts');
let temp: string;
let repo: string;

function orc(args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_')));
  return spawnSync(process.execPath, [ORC, ...args], { cwd: repo, env: { ...env, ORC_DATA_HOME: join(temp, 'data') }, encoding: 'utf8' });
}

beforeEach(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'orc-task-cancel-')));
  repo = join(temp, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: repo });
  expect(orc(['project', 'add', repo]).status).toBe(0);
  expect(orc(['project', 'task', 'create', '--feature=app', '--title=Doomed']).status).toBe(0);
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe('orc task-cancel', { timeout: 30_000 }, () => {
  it('lets the operator cancel a project task without the master, and refuses a terminal one', () => {
    const cancelled = orc(['task-cancel', 'app/doomed', '--reason=not needed']);
    expect(cancelled.status).toBe(0);
    expect(cancelled.stdout).toContain('task cancelled: app/doomed (status: cancelled)');
    expect(cancelled.stderr).toContain('coordinator is not running; applying cancel-task directly');
    const again = orc(['task-cancel', 'app/doomed']);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('already_terminal');
  });

  it('prints usage without a task ref', () => {
    const result = orc(['task-cancel']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc task-cancel');
  });
});
