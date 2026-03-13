import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-master-check-cli-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli/master-check.ts', () => {
  it('prints failure reason and exit code when present', () => {
    seedQueue([
      {
        seq: 1,
        consumed: false,
        type: 'TASK_COMPLETE',
        task_ref: 'orch/task-120',
        agent_id: 'orc-1',
        success: false,
        failure_reason: 'tests failed',
        exit_code: 'ERR_TESTS',
        finished_at: '2026-03-09T08:53:02.000Z',
      },
    ]);

    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Reason:  tests failed');
    expect(result.stdout).toContain('Exit:    ERR_TESTS');
  });

  it('reads legacy entries without failure_reason or exit_code', () => {
    seedQueue([
      {
        seq: 1,
        consumed: false,
        type: 'TASK_COMPLETE',
        task_ref: 'orch/task-legacy',
        agent_id: 'orc-2',
        success: false,
        finished_at: '2026-03-09T08:53:02.000Z',
      },
    ]);

    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Task:    orch/task-legacy');
    expect(result.stdout).not.toContain('Reason:');
    expect(result.stdout).not.toContain('Exit:');
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['--experimental-strip-types', 'cli/master-check.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedQueue(entries: unknown[]) {
  const lines = entries.map((entry) => JSON.stringify(entry));
  writeFileSync(join(dir, 'master-notify-queue.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}
