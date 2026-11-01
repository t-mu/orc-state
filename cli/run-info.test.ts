import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-run-info-test-');
  seedState();
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/run-info.ts', () => {
  it('prints run summary in human-readable format', () => {
    const result = runCli(['run-1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run-1');
    expect(result.stdout).toContain('docs/task-1');
    expect(result.stdout).toContain('worker-1');
    expect(result.stdout).toContain('in_progress');
  });

  it('outputs json with --json flag', () => {
    const result = runCli(['run-1', '--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.run_id).toBe('run-1');
    expect(json.task_ref).toBe('docs/task-1');
    expect(json.agent_id).toBe('worker-1');
    expect(json.state).toBe('in_progress');
  });

  it('exits 1 when run-id is not provided', () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-info');
  });

  it('exits 1 when run-id is not found', () => {
    const result = runCli(['run-missing']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run not found');
  });

  it('measures idle from hook activity in run-activity.json when it is newer than the heartbeat', () => {
    const before = runCli(['run-1']);
    const staleIdle = Number(/idle:\s+(\d+)s/.exec(before.stdout)?.[1]);
    expect(staleIdle).toBeGreaterThan(3600);

    const toolTs = new Date(Date.now() - 30_000).toISOString();
    writeFileSync(join(dir, 'run-activity.json'), JSON.stringify({
      version: 1,
      runs: { 'run-1': {
        run_id: 'run-1', agent_id: 'worker-1', label: 'Bash: npm test', source: 'tool', label_ts: toolTs,
        last_tool: 'Bash', last_tool_brief: 'npm test', last_tool_ts: toolTs,
      } },
    }));
    const result = runCli(['run-1']);
    expect(result.status).toBe(0);
    const idle = Number(/idle:\s+(\d+)s/.exec(result.stdout)?.[1]);
    expect(idle).toBeGreaterThanOrEqual(30);
    expect(idle).toBeLessThan(300);
  });

  it('includes task title in json output when task exists in backlog', () => {
    const result = runCli(['run-1', '--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.task_title).toBe('Task 1');
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/run-info.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState() {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: 'worker-1', provider: 'claude', role: 'worker', status: 'running', session_handle: 'claude:session-1', registered_at: '2026-01-01T00:00:00Z' }],
  }));
  const claims = [{
    run_id: 'run-1',
    task_ref: 'docs/task-1',
    agent_id: 'worker-1',
    state: 'in_progress',
    claimed_at: '2026-01-01T00:00:00Z',
    started_at: '2026-01-01T00:01:00Z',
    lease_expires_at: '2099-01-01T00:00:00Z',
  }];
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  seedProjectTasks(dir, [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }], claims);
  writeFileSync(join(dir, 'events.jsonl'), '');
}
