import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks, readBacklog, recordMergeConfirmation } from '../test-fixtures/stateHelpers.ts';
import { initEventsDb, queryEvents } from '../lib/eventLog.ts';
import Database from 'better-sqlite3';
import { initProjectTaskStore } from '../lib/projectTasks.ts';
import { runWorkerCli } from '../test-fixtures/projectCli.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-progress-cli-test-');
  seedState(dir);
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/progress.ts', () => {
  it('rejects unknown events', async () => {
    const result = await runCli(['--event=unknown', '--run-id=run-1', '--agent-id=bob']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported event');
  });

  it('rejects run_started for non-owner agent', async () => {
    const result = await runCli(['--event=run_started', '--run-id=run-1', '--agent-id=alice']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('belongs to bob');
  });

  it('accepts phase_started before coordinator has processed run_started and leaves claims untouched', async () => {
    const before = readClaims();
    const result = await runCli(['--event=phase_started', '--run-id=run-1', '--agent-id=bob', '--phase=implement']);
    expect(result.status).toBe(0);
    expect(readClaims()).toEqual(before);
    expect(readEvents().some((event) => event.event === 'phase_started' && event.phase === 'implement')).toBe(true);
  });

  it('commits run_started once and accepts a duplicate report', async () => {
    const first = await runCli(['--event=run_started', '--run-id=run-1', '--agent-id=bob']);
    const result = await runCli(['--event=run_started', '--run-id=run-1', '--agent-id=bob']);
    expect(first.status).toBe(0);
    expect(result.status).toBe(0);
    expect(readClaims().claims[0].state).toBe('in_progress');
    expect(readEvents().filter((event) => event.event === 'run_started')).toHaveLength(1);
  });

  it('rolls back a reported start if its event insert fails', async () => {
    initEventsDb(dir);
    const db = new Database(join(dir, 'events.db'));
    try {
      db.exec("CREATE TRIGGER reject_start BEFORE INSERT ON events WHEN new.event = 'run_started' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END");
    } finally {
      db.close();
    }
    const result = await runCli(['--event=run_started', '--run-id=run-1', '--agent-id=bob']);
    expect(result.status).toBe(1);
    expect(readClaims().claims[0].state).toBe('claimed');
    expect(readEvents().filter((event) => event.event === 'run_started')).toEqual([]);
  });

  it('commits run_finished with the completed run', async () => {
    // A worker finishes only after the coordinator's merge confirmation records `done`.
    initProjectTaskStore(dir).applyTransition('docs/task-1', { cause: 'run_start', to: 'in_progress', runId: 'run-1', actorId: 'bob' });
    recordMergeConfirmation(dir, 'docs/task-1');
    const result = await runCli(['--event=run_finished', '--run-id=run-1', '--agent-id=bob']);
    expect(result.status).toBe(0);
    expect(readClaims().claims[0].state).toBe('done');
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('done');
    expect(readEvents().some((event) => event.event === 'run_finished' && event.run_id === 'run-1')).toBe(true);
  });

  it('commits run_failed with the failed run', async () => {
    const result = await runCli(['--event=run_failed', '--run-id=run-1', '--agent-id=bob', '--reason=boom']);
    expect(result.status).toBe(0);
    expect(readClaims().claims[0].state).toBe('failed');
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('todo');
    expect(readEvents().some((event) => event.event === 'run_failed' && event.run_id === 'run-1')).toBe(true);
  });

  it('accepts work_complete as an append-only event and leaves claims untouched', async () => {
    const before = readClaims();
    const result = await runCli(['--event=work_complete', '--run-id=run-1', '--agent-id=bob']);
    expect(result.status).toBe(0);
    expect(readClaims()).toEqual(before);
    expect(readEvents().some((event) => event.event === 'work_complete' && event.run_id === 'run-1')).toBe(true);
  });

  it('rejects heartbeat before run_started', async () => {
    const before = readClaims();
    const result = await runCli(['--event=heartbeat', '--run-id=run-1', '--agent-id=bob']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("heartbeat requires run_started first");
    expect(readClaims()).toEqual(before);
    expect(readEvents().some((event) => event.event === 'heartbeat' && event.run_id === 'run-1')).toBe(false);
  });

  it('requires reason for run_failed', async () => {
    await runCli(['--event=run_started', '--run-id=run-1', '--agent-id=bob']);
    const result = await runCli(['--event=run_failed', '--run-id=run-1', '--agent-id=bob', '--policy=requeue']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires --reason');
  });

  it('returns run-not-found error for unknown run id', async () => {
    const result = await runCli(['--event=run_started', '--run-id=run-missing', '--agent-id=bob']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Run not found in claims');
  });
});

function runCli(args: string[]) {
  return runWorkerCli(dir, 'progress.ts', args);
}

function seedState(stateDir: string) {
  writeFileSync(join(stateDir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z', session_handle: 'openai:session-bob', provider_ref: null }],
  }));
  const claims = [{
    run_id: 'run-1',
    task_ref: 'docs/task-1',
    agent_id: 'bob',
    state: 'claimed',
    claimed_at: '2026-01-01T00:00:00Z',
    lease_expires_at: '2099-01-01T00:00:00Z',
    last_heartbeat_at: null,
    started_at: null,
    finished_at: null,
  }];
  writeFileSync(join(stateDir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  seedProjectTasks(stateDir, [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed', depends_on: [], acceptance_criteria: ['a', 'b', 'c'] }], claims);
  writeFileSync(join(stateDir, 'events.jsonl'), '');
}

function readClaims() {
  return JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8'));
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
