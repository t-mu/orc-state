import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ORC = resolve(import.meta.dirname, 'orc.ts');
let temp: string;
let repo: string;

function orc(args: string[], extra: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_')));
  return spawnSync(process.execPath, [ORC, ...args], { cwd: repo, env: { ...env, ORC_DATA_HOME: join(temp, 'data'), ...extra }, encoding: 'utf8' });
}

/** The single JSON document a `--json` command prints on stdout. */
function out(result: ReturnType<typeof orc>): Record<string, unknown> & { error: { code: string; message: string }; pid: number; socket: unknown; version: unknown } {
  return JSON.parse(result.stdout);
}

beforeEach(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'orc-operator-json-')));
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
  orc(['coordinator', 'stop']);
  rmSync(temp, { recursive: true, force: true });
});

describe('operator commands with --json', { timeout: 30_000 }, () => {
  it('prints the operator result on success', () => {
    const cancelled = orc(['task-cancel', 'app/doomed', '--json']);
    expect(cancelled.status).toBe(0);
    expect(out(cancelled)).toMatchObject({ status: 'cancelled' });
  });

  it('prints {error:{code}} and exits 1 for an unknown task, on every task command', () => {
    for (const command of ['task-cancel', 'task-reset', 'task-unblock', 'task-mark-done']) {
      const result = orc([command, 'app/missing', '--json']);
      expect(result.status, command).toBe(1);
      expect(out(result).error.code, command).toBe('not_found');
      expect(out(result).error.message, command).toContain('app/missing');
    }
  });

  it('reports a terminal task as a conflict', () => {
    expect(orc(['task-cancel', 'app/doomed']).status).toBe(0);
    const again = orc(['task-cancel', 'app/doomed', '--json']);
    expect(again.status).toBe(1);
    expect(out(again).error.code).toBe('conflict');
    expect(out(orc(['task-unblock', 'app/doomed', '--json'])).error.code).toBe('conflict');
  });

  it('reports unknown runs as not_found and keeps the text form without --json', () => {
    for (const command of ['run-close', 'run-expire']) {
      const result = orc([command, 'run-nope', '--json']);
      expect(result.status, command).toBe(1);
      expect(out(result).error.code, command).toBe('not_found');
    }
    const text = orc(['run-close', 'run-nope']);
    expect(text.status).toBe(1);
    expect(text.stdout).toBe('');
    expect(text.stderr).toContain('Error:');
  });

  it('prints delegate and respond-input failures as JSON', () => {
    expect(out(orc(['delegate', '--task-ref=app/missing', '--json'])).error.code).toBe('not_found');
    const respond = orc(['run-input-respond', '--run-id=run-x', '--agent-id=nobody', '--response=ok', '--json']);
    expect(respond.status).toBe(1);
    expect(out(respond).error).toEqual({ code: expect.any(String), message: expect.any(String) });
  });

  it('prints worker-remove, worker-gc and kill-all results as JSON', () => {
    const missing = orc(['worker-remove', 'ghost', '--json']);
    expect(missing.status).toBe(1);
    expect(out(missing).error.code).toBe('not_found');
    expect(out(orc(['worker-gc', '--json']))).toEqual({ removed_workers: 0, removed_hook_files: 0 });
    const killed = orc(['kill-all', '--json']);
    expect(killed.status).toBe(0);
    expect(out(killed)).toMatchObject({ coordinator: 'not_running', tasks_reset: 0, claims_cancelled: 0 });
  });
});

describe('orc coordinator', { timeout: 60_000 }, () => {
  it('starts only the coordinator, reports it, and stops it without touching tasks', () => {
    const idle = orc(['coordinator', 'status', '--json']);
    expect(idle.status).toBe(0);
    expect(out(idle)).toMatchObject({ running: false, pid: null });

    const started = orc(['coordinator', 'start', '--json']);
    expect(started.status).toBe(0);
    const info = out(started);
    expect(info).toMatchObject({ action: 'start', running: true, changed: true });
    expect(info.pid).toBeGreaterThan(0);

    const status = out(orc(['coordinator', 'status', '--json']));
    expect(status).toMatchObject({ running: true, pid: info.pid });
    expect(typeof status.socket).toBe('string');
    expect(typeof status.version).toBe('string');
    expect(out(orc(['coordinator', 'start', '--json']))).toMatchObject({ running: true, pid: info.pid, changed: false });

    const stopped = orc(['coordinator', 'stop', '--json']);
    expect(stopped.status).toBe(0);
    expect(out(stopped)).toMatchObject({ running: false, changed: true });
    expect(out(orc(['coordinator', 'stop', '--json']))).toMatchObject({ running: false, changed: false });
    expect(out(orc(['project', 'task', 'show', 'app/doomed'])).status).toBe('todo');
  });

  it('rejects an unknown action with usage', () => {
    const result = orc(['coordinator', 'restart']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc coordinator');
  });
});
