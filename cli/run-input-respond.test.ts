import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, queryEvents, withEventDbTransaction } from '../lib/eventLog.ts';
import { bridgeInputRequest } from '../lib/messageBridge.ts';
import { recordMasterSession, runProjectCli } from '../test-fixtures/projectCli.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-run-input-respond-test-');
  seedState();
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/run-input-respond.ts', () => {
  it('emits input_response event', () => {
    const result = runCli(['--run-id=run-1', '--agent-id=worker-1', '--response=yes do it']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('input_response: run-1 (worker-1)');
    const events = readEvents();
    const event = events.find((e) => e.event === 'input_response' && e.run_id === 'run-1');
    expect(event).toBeDefined();
    expect((event?.payload as Record<string, unknown>)?.response).toBe('yes do it');
  });

  it('includes question from prior input_requested event in payload', () => {
    // Seed a prior input_requested event
    writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({
      seq: 1,
      ts: '2026-01-01T00:02:00Z',
      event: 'input_requested',
      actor_type: 'agent',
      actor_id: 'worker-1',
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-1',
      payload: { question: 'which approach?', request_id: 'req-abc' },
    }) + '\n');
    const result = runCli(['--run-id=run-1', '--agent-id=worker-1', '--response=use approach A']);
    expect(result.status).toBe(0);
    const events = readEvents();
    const event = events.find((e) => e.event === 'input_response' && e.run_id === 'run-1');
    expect((event?.payload as Record<string, unknown>)?.question).toBe('which approach?');
  });

  it('uses default actor-id of master when --actor-id not provided', () => {
    const result = runCli(['--run-id=run-1', '--agent-id=worker-1', '--response=done']);
    expect(result.status).toBe(0);
    const events = readEvents();
    const event = events.find((e) => e.event === 'input_response');
    expect(event?.actor_id).toBe('master');
  });

  it('records the master session even when --actor-id names another agent', () => {
    const result = runCli(['--run-id=run-1', '--agent-id=worker-1', '--response=done', '--actor-id=orc-master-1']);
    expect(result.status).toBe(0);
    const events = readEvents();
    const event = events.find((e) => e.event === 'input_response');
    expect(event?.actor_id).toBe('master');
  });

  it('exits 1 and records nothing when the run never asked', () => {
    const result = runCli(['--run-id=run-typo', '--agent-id=worker-1', '--response=yes']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Input request is not pending');
    expect(readEvents().some((e) => e.event === 'input_response')).toBe(false);
  });

  it('exits 1 when --run-id is missing', () => {
    const result = runCli(['--agent-id=worker-1', '--response=done']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-input-respond');
  });

  it('exits 1 when --response is missing', () => {
    const result = runCli(['--run-id=run-1', '--agent-id=worker-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc run-input-respond');
  });
});

describe('cli/run-input-respond.ts durable request', () => {
  beforeEach(() => {
    // The durable request below is the only one.
    writeFileSync(join(dir, 'events.jsonl'), '');
    initEventsDb(dir);
    withEventDbTransaction(dir, (db) => {
      db.prepare("INSERT INTO runs (run_id, task_ref, agent_id, state, created_at, updated_at) VALUES ('run-1', 'docs/task-1', 'worker-1', 'in_progress', 'now', 'now')").run();
    });
    bridgeInputRequest(dir, 'run-1', 'worker-1', 'req-1', 'Which approach?');
    closeAllDatabases();
  });

  it('answers as the master session', () => {
    expect(runCli(['--run-id=run-1', '--agent-id=worker-1', '--response=A']).status).toBe(0);
  });

  it('answers from an operator shell without the master session, and ignores a session id', () => {
    for (const env of [{ ORC_MASTER_SECRET: '' }, { ORC_MASTER_SECRET: '', ORC_SESSION_ID: 'session-master', ORC_SESSION_TOKEN: 'session-master' }]) {
      const result = runCli(['--run-id=run-1', '--agent-id=worker-1', '--response=A', '--request-id=req-1'], env);
      expect(result.status).toBe(0);
    }
  });

  it('refuses a stale request id', () => {
    const result = runCli(['--run-id=run-1', '--agent-id=worker-1', '--response=A', '--request-id=req-old'], { ORC_MASTER_SECRET: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not pending');
  });
});

function runCli(args: string[], env: Record<string, string> = {}) {
  // Registered just before the call: opening the event store imports the events.jsonl a test seeded.
  const masterSecret = recordMasterSession(dir);
  closeAllDatabases();
  return runProjectCli(dir, 'cli/run-input-respond.ts', args, { ORC_MASTER_SECRET: masterSecret, ...env });
}

function seedState() {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
      { agent_id: 'worker-1', provider: 'claude', role: 'worker', status: 'running', session_handle: 'claude:session-1', registered_at: '2026-01-01T00:00:00Z' },
    ],
  }));
  const claims = [{
    run_id: 'run-1',
    task_ref: 'docs/task-1',
    agent_id: 'worker-1',
    state: 'in_progress',
    input_state: 'awaiting_input',
    claimed_at: '2026-01-01T00:00:00Z',
    started_at: '2026-01-01T00:01:00Z',
    lease_expires_at: '2099-01-01T00:00:00Z',
  }];
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  // The worker asked; a test that needs a different question overwrites this.
  seedProjectTasks(dir, [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }], claims);
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({
    seq: 1, ts: '2026-01-01T00:02:00Z', event: 'input_requested', actor_type: 'agent', actor_id: 'worker-1',
    run_id: 'run-1', task_ref: 'docs/task-1', agent_id: 'worker-1', payload: { question: 'ready?', request_id: 'req-0' },
  }) + '\n');
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
