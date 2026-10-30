import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks, readClaims } from '../test-fixtures/stateHelpers.ts';
import { queryEvents } from '../lib/eventLog.ts';
import { runWorkerCli } from '../test-fixtures/projectCli.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-run-start-test-');
  seedState();
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/run-start.ts', () => {
  it('succeeds with a valid claimed run and emits run_started event', async () => {
    const result = await runCli(['--run-id=run-1', '--agent-id=worker-1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run_started: run-1 (worker-1)');
    const events = readEvents();
    const event = events.find((e) => e.event === 'run_started' && e.run_id === 'run-1');
    expect(event).toBeDefined();
    expect(event?.agent_id).toBe('worker-1');
  });

  it('transitions claim state to in_progress', async () => {
    await runCli(['--run-id=run-1', '--agent-id=worker-1']);
    const claims = readClaims(dir);
    const claim = claims.find((c: Record<string, unknown>) => c.run_id === 'run-1');
    expect(claim?.state).toBe('in_progress');
  });

  it('is idempotent when claim is already in_progress', async () => {
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({
      version: '1',
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'worker-1',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00Z',
        started_at: '2026-01-01T00:01:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    }));
    const result = await runCli(['--run-id=run-1', '--agent-id=worker-1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run_started: run-1 (worker-1)');
  });

  it('exits 1 when --run-id is missing', async () => {
    const result = await runCli(['--agent-id=worker-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-start');
  });

  it('exits 1 when --agent-id is missing', async () => {
    const result = await runCli(['--run-id=run-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-start');
  });

  it('exits 1 when run-id does not exist in claims', async () => {
    const result = await runCli(['--run-id=run-missing', '--agent-id=worker-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
  });

  it('exits 1 when agent-id does not match claim', async () => {
    const result = await runCli(['--run-id=run-1', '--agent-id=wrong-agent']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
  });
});

function runCli(args: string[]) {
  return runWorkerCli(dir, 'run-start.ts', args);
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
    state: 'claimed',
    claimed_at: '2026-01-01T00:00:00Z',
    lease_expires_at: '2099-01-01T00:00:00Z',
  }];
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  seedProjectTasks(dir, [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }], claims);
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
