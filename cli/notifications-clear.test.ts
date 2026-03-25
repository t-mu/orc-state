import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendNotification } from '../lib/masterNotifyQueue.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-notifications-clear-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli/notifications-clear.ts', () => {
  it('reports 0 when no notifications are pending', () => {
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No pending notifications');
  });

  it('clears all pending notifications and reports count', () => {
    appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'orch/task-1', agent_id: 'orc-1', success: true });
    appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'orch/task-2', agent_id: 'orc-1', success: false });

    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Cleared 2 notifications');
  });

  it('reports singular "notification" for a single entry', () => {
    appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'orch/task-1', agent_id: 'orc-1', success: true });

    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Cleared 1 notification.');
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['--experimental-strip-types', 'cli/notifications-clear.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}
