import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';
import { queryEvents } from '../lib/eventLog.ts';
import { runWorkerCli } from '../test-fixtures/projectCli.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-run-input-request-test-');
  seedState();
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/run-input-request.ts', () => {
  it('emits input_requested event before timing out', { timeout: 10_000 }, async () => {
    // Use very short timeout so test completes quickly
    const result = await runCli(['--run-id=run-1', '--agent-id=worker-1', '--question=what to do?', '--timeout-ms=50', '--poll-ms=10']);
    // Expected to exit 1 (timeout) but input_requested event should have been emitted
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Timed out');
    const events = readEvents();
    const event = events.find((e) => e.event === 'input_requested' && e.run_id === 'run-1');
    expect(event).toBeDefined();
    expect((event?.payload as Record<string, unknown>)?.question).toBe('what to do?');
  });

  it('exits 1 when --run-id is missing', async () => {
    const result = await runCli(['--agent-id=worker-1', '--question=hello?']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-input-request');
  });

  it('exits 1 when --agent-id is missing', async () => {
    const result = await runCli(['--run-id=run-1', '--question=hello?']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-input-request');
  });

  it('exits 1 when --question is missing', async () => {
    const result = await runCli(['--run-id=run-1', '--agent-id=worker-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-input-request');
  });

  it('exits immediately when claim is not in_progress', { timeout: 10_000 }, async () => {
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({
      version: '1',
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'worker-1',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    }));
    const result = await runCli(['--run-id=run-1', '--agent-id=worker-1', '--question=hello?', '--timeout-ms=100']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Timed out');
  });
});

function runCli(args: string[]) {
  return runWorkerCli(dir, 'run-input-request.ts', args);
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

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
