import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { closeAllDatabases, initEventsDb, queryEvents, withEventDbTransaction } from '../lib/eventLog.ts';
import { bridgeInputRequest } from '../lib/messageBridge.ts';

const repoRoot = resolve(import.meta.dirname, '..');
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

  it('uses provided --actor-id', () => {
    const result = runCli(['--run-id=run-1', '--agent-id=worker-1', '--response=done', '--actor-id=orc-master-1']);
    expect(result.status).toBe(0);
    const events = readEvents();
    const event = events.find((e) => e.event === 'input_response');
    expect(event?.actor_id).toBe('orc-master-1');
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

describe('cli/run-input-respond.ts durable request in a legacy installation', () => {
  beforeEach(() => {
    // The durable request below is the only one.
    writeFileSync(join(dir, 'events.jsonl'), '');
    initEventsDb(dir);
    withEventDbTransaction(dir, (db) => {
      db.prepare("INSERT INTO runs (run_id, task_ref, agent_id, state, created_at, updated_at) VALUES ('run-1', 'docs/task-1', 'worker-1', 'in_progress', 'now', 'now')").run();
      db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at)
        VALUES ('master-1', NULL, 'master', 'claude', 'running', 'now', 'now')`).run();
    });
    bridgeInputRequest(dir, 'run-1', 'worker-1', 'req-1', 'Which approach?');
    closeAllDatabases();
  });

  it('answers as the master named by --session-id', () => {
    expect(runCli(['--run-id=run-1', '--agent-id=worker-1', '--response=A', '--session-id=master-1']).status).toBe(0);
  });

  it('accepts the older --session-token name and the legacy ORC_SESSION_TOKEN variable', () => {
    expect(runCli(['--run-id=run-1', '--agent-id=worker-1', '--response=A', '--session-token=master-1']).status).toBe(0);
    expect(runCli(['--run-id=run-1', '--agent-id=worker-1', '--response=A'], { ORC_SESSION_TOKEN: 'master-1' }).status).toBe(0);
  });

  it('refuses without the master session id', () => {
    const result = runCli(['--run-id=run-1', '--agent-id=worker-1', '--response=A']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('running master session');
  });
});

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync('node', ['cli/run-input-respond.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: dir, ORC_SESSION_ID: '', ORC_SESSION_TOKEN: '', ORC_SESSION_SECRET: '', ORC_MASTER_SECRET: '', ...env },
    encoding: 'utf8',
  });
}

function seedState() {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{
      ref: 'docs',
      title: 'Docs',
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }],
    }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: 'worker-1', provider: 'claude', role: 'worker', status: 'running', session_handle: 'claude:session-1', registered_at: '2026-01-01T00:00:00Z' }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: [{
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-1',
      state: 'in_progress',
      input_state: 'awaiting_input',
      claimed_at: '2026-01-01T00:00:00Z',
      started_at: '2026-01-01T00:01:00Z',
      lease_expires_at: '2099-01-01T00:00:00Z',
    }],
  }));
  // The worker asked; a test that needs a different question overwrites this.
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({
    seq: 1, ts: '2026-01-01T00:02:00Z', event: 'input_requested', actor_type: 'agent', actor_id: 'worker-1',
    run_id: 'run-1', task_ref: 'docs/task-1', agent_id: 'worker-1', payload: { question: 'ready?', request_id: 'req-0' },
  }) + '\n');
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
