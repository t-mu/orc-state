import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';
import { queryEvents } from '../lib/eventLog.ts';
import { runWorkerCli } from '../test-fixtures/projectCli.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-run-fail-test-');
  seedState();
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/run-fail.ts', () => {
  it('emits run_failed event with default policy requeue', async () => {
    const result = await runCli(['--run-id=run-1', '--agent-id=worker-1', '--reason=something broke']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run_failed: run-1 (worker-1)');
    const events = readEvents();
    const event = events.find((e) => e.event === 'run_failed' && e.run_id === 'run-1');
    expect(event).toBeDefined();
    expect(event?.payload?.reason).toBe('something broke');
    expect(event?.payload?.policy).toBe('requeue');
  });

  it('emits run_failed event with block policy', async () => {
    const result = await runCli(['--run-id=run-1', '--agent-id=worker-1', '--reason=blocked', '--policy=block']);
    expect(result.status).toBe(0);
    const events = readEvents();
    const event = events.find((e) => e.event === 'run_failed' && e.run_id === 'run-1');
    expect(event?.payload?.policy).toBe('block');
  });

  it('uses default reason when --reason is not provided', async () => {
    const result = await runCli(['--run-id=run-1', '--agent-id=worker-1']);
    expect(result.status).toBe(0);
    const events = readEvents();
    const event = events.find((e) => e.event === 'run_failed' && e.run_id === 'run-1');
    expect(event?.payload?.reason).toBe('worker reported failure');
  });

  it('exits 1 when --run-id is missing', async () => {
    const result = await runCli(['--agent-id=worker-1', '--reason=fail']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-fail');
  });

  it('exits 1 when --agent-id is missing', async () => {
    const result = await runCli(['--run-id=run-1', '--reason=fail']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-fail');
  });

  it('exits 1 when policy is invalid', async () => {
    const result = await runCli(['--run-id=run-1', '--agent-id=worker-1', '--policy=invalid']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid policy');
  });

  it('exits 1 when run-id does not exist in claims', async () => {
    const result = await runCli(['--run-id=run-missing', '--agent-id=worker-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
  });
});

function runCli(args: string[]) {
  return runWorkerCli(dir, 'run-fail.ts', args);
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
  writeFileSync(join(dir, 'events.jsonl'), '');
  seedProjectTasks(dir, [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }], claims);
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
