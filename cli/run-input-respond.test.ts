import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { queryEvents } from '../lib/eventLog.ts';

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

function runCli(args: string[]) {
  return spawnSync('node', ['cli/run-input-respond.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
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
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
