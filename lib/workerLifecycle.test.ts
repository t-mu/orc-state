import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempStateDir, createTempStateDir, seedProjectTasks, seedState } from '../test-fixtures/stateHelpers.ts';
import { credentialHash } from './sessionCredentials.ts';
import { closeAllDatabases, initEventsDb, withEventDbTransaction } from './eventLog.ts';
import { commitClaims } from './runStore.ts';
import { applyLifecycle, authorizeLifecycle, parseLifecycleRequest } from './workerLifecycle.ts';
import type { Claim } from '../types/claims.ts';

let dir: string;

function claim(state: Claim['state']): Claim {
  return {
    run_id: 'run-a', task_ref: 'orch/task-a', agent_id: 'worker-a', state,
    claimed_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:01.000Z', lease_expires_at: '2099-01-01T00:00:00.000Z',
  };
}

function session(state: 'running' | 'recoverable' | 'unknown' | 'offline'): void {
  withEventDbTransaction(dir, (db) => {
    db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at, credential_hash)
      VALUES ('session-a', 'run-a', 'worker-a', 'claude', ?, '2026-01-01', '2026-01-01', ?)`).run(state, credentialHash('session-a'));
  });
}

beforeEach(() => {
  dir = createTempStateDir('orch-lifecycle-');
  seedState(dir);
  initEventsDb(dir);
});

afterEach(() => {
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

describe('parseLifecycleRequest', () => {
  it('accepts each op with its required fields and rejects malformed bodies', () => {
    expect(parseLifecycleRequest({ op: 'run-start', run_id: 'run-a', agent_id: 'worker-a' })).toMatchObject({ op: 'run-start' });
    expect(parseLifecycleRequest({ op: 'memory-record', content: 'x' })).toMatchObject({ op: 'memory-record' });
    for (const body of [
      { op: 'delete-everything', run_id: 'run-a', agent_id: 'worker-a' },
      { op: 'run-start', agent_id: 'worker-a' },
      { op: 'run-fail', run_id: 'run-a', agent_id: 'worker-a', reason: 'r', code: 'c' },
      { op: 'review-submit', run_id: 'run-a', agent_id: 'worker-a', outcome: 'maybe', reason: 'r' },
      { op: 'input-poll', run_id: 'run-a', agent_id: 'worker-a', request_id: 'q', request_seq: '1' },
      { op: 'progress', run_id: 'run-a', agent_id: 'worker-a', event: 'phase_started', phase: 7 },
    ]) {
      expect(() => parseLifecycleRequest(body), JSON.stringify(body)).toThrow(expect.objectContaining({ code: 'bad_request' }));
    }
  });
});

describe('authorizeLifecycle', () => {
  it('lets an ended session repeat run-finish only for its own finished run', () => {
    const finish = { op: 'run-finish', run_id: 'run-a', agent_id: 'worker-a' } as const;
    commitClaims(dir, { version: '1', claims: [claim('in_progress')] });
    session('offline');
    expect(() => authorizeLifecycle(dir, 'session-a', finish)).toThrow(expect.objectContaining({ code: 'unauthenticated' }));
    // The coordinator has recorded the merge: the task is done and the run finished.
    seedProjectTasks(dir, [{ ref: 'orch/task-a', status: 'done' }]);
    commitClaims(dir, { version: '1', claims: [claim('done')] });
    expect(() => authorizeLifecycle(dir, 'session-a', finish)).not.toThrow();
    expect(applyLifecycle(dir, finish).message).toBe('run_finished: run-a (worker-a)');
    // Nothing else is accepted from a session that has ended.
    expect(() => authorizeLifecycle(dir, 'session-a', { op: 'run-work-complete', run_id: 'run-a', agent_id: 'worker-a' }))
      .toThrow(expect.objectContaining({ code: 'unauthenticated' }));
  });

  it('accepts recoverable and unknown sessions after a coordinator restart, but not offline ones', () => {
    commitClaims(dir, { version: '1', claims: [claim('in_progress')] });
    session('recoverable');
    const complete = { op: 'run-work-complete', run_id: 'run-a', agent_id: 'worker-a' } as const;
    const setState = (state: string) => withEventDbTransaction(dir, (db) => {
      db.prepare('UPDATE sessions SET state = ? WHERE session_id = ?').run(state, 'session-a');
    });
    expect(() => authorizeLifecycle(dir, 'session-a', complete)).not.toThrow();
    setState('unknown');
    expect(() => authorizeLifecycle(dir, 'session-a', complete)).not.toThrow();
    setState('offline');
    expect(() => authorizeLifecycle(dir, 'session-a', complete)).toThrow(expect.objectContaining({ code: 'unauthenticated' }));
    // A reaped session may still poll its own input request and learn the run ended.
    const poll = { op: 'input-poll', run_id: 'run-a', agent_id: 'worker-a', request_id: 'q-1', request_seq: 0 } as const;
    // Reported as not live, so the control server drops its heartbeat.
    expect(authorizeLifecycle(dir, 'session-a', poll)).toEqual({ live: false });
    expect(() => authorizeLifecycle(dir, 'session-a', { ...poll, run_id: 'run-b' })).toThrow(expect.objectContaining({ code: 'unauthenticated' }));
  });

  it('accepts progress run_finished from an ended session once the run is done', () => {
    commitClaims(dir, { version: '1', claims: [claim('done')] });
    session('offline');
    expect(() => authorizeLifecycle(dir, 'session-a', { op: 'progress', run_id: 'run-a', agent_id: 'worker-a', event: 'run_finished' })).not.toThrow();
    expect(() => authorizeLifecycle(dir, 'session-a', { op: 'progress', run_id: 'run-a', agent_id: 'worker-a', event: 'phase_started', phase: 'x' }))
      .toThrow(expect.objectContaining({ code: 'unauthenticated' }));
  });

  it('does not let a run read another run\'s input answer by request id', () => {
    commitClaims(dir, { version: '1', claims: [claim('in_progress'), { ...claim('in_progress'), run_id: 'run-b', agent_id: 'worker-b', task_ref: 'orch/task-b' }] });
    withEventDbTransaction(dir, (db) => {
      db.prepare(`INSERT INTO input_requests (request_id, run_id, idempotency_key, question, state, response, created_at)
        VALUES ('q-b', 'run-b', 'input:q-b', 'secret?', 'answered', 'the answer', '2026-01-01')`).run();
    });
    const poll = (runId: string, agentId: string) => applyLifecycle(dir, { op: 'input-poll', run_id: runId, agent_id: agentId, request_id: 'q-b', request_seq: 0 });
    expect(poll('run-a', 'worker-a').response).toBeNull();
    expect(poll('run-b', 'worker-b').response).toBe('the answer');
  });

  it('treats progress run_started as idempotent once the run is in progress', () => {
    commitClaims(dir, { version: '1', claims: [claim('in_progress')] });
    expect(applyLifecycle(dir, { op: 'progress', run_id: 'run-a', agent_id: 'worker-a', event: 'run_started' }).message)
      .toBe('progress event accepted: run_started run=run-a agent=worker-a');
  });

  it('refuses derived legacy credentials', () => {
    expect(() => authorizeLifecycle(dir, 'legacy-worker-a', { op: 'memory-record', content: 'x' }))
      .toThrow(expect.objectContaining({ code: 'unauthenticated' }));
  });
});

describe('progress --note', () => {
  it('persists the note on the event and feeds the activity snapshot as a note', async () => {
    const { readFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { dispatchHookEvents } = await import('./hookEventBus.ts');
    const { applyHookActivity } = await import('./runActivityStore.ts');
    const { selectCurrentActivity } = await import('./currentActivity.ts');
    const { readEventsSince } = await import('./eventLog.ts');
    commitClaims(dir, { version: '1', claims: [claim('in_progress')] });
    applyLifecycle(dir, { op: 'progress', run_id: 'run-a', agent_id: 'worker-a', event: 'phase_started', phase: 'implement', note: '  Fixing findings from the critic ' });
    const file = join(dir, 'pty-hook-events', 'worker-a.ndjson');
    const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    rmSync(file);
    const { activity } = dispatchHookEvents(records, 'worker-a');
    const snapshot = applyHookActivity(undefined, 'run-a', 'worker-a', activity);
    expect(selectCurrentActivity(snapshot)).toMatchObject({ text: 'Fixing findings from the critic', source: 'note' });
    const events = readEventsSince(join(dir, 'events.db'), 0).filter((e) => e.event === 'phase_started');
    expect(events.at(-1)?.payload).toMatchObject({ note: 'Fixing findings from the critic' });
  });
});
