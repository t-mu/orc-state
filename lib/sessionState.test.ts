import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { queryEvents } from './eventLog.ts';
import { recordProviderSession } from './runStore.ts';
import {
  appendSessionStartedEvent, prepareSessionReuse, resetVolatileRuntimeStateForSession, restoreVolatileRuntimeStateFromSnapshot, stopSessionsForReset,
} from './sessionState.ts';
import { listSupervisedSessions, reconcileSessions } from './sessionSupervisor.ts';
import { readAgents, readClaims } from './stateReader.ts';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks, readBacklog } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-session-state-test-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [
      {
        agent_id: 'master',
        provider: 'claude',
        role: 'master',
        status: 'running',
        session_handle: 'tmux:master',
        provider_ref: { pid: 123 },
        registered_at: '2026-01-01T00:00:00Z',
        last_heartbeat_at: '2026-01-01T00:00:00Z',
      },
      {
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'tmux:orc-1',
        provider_ref: { pid: 456 },
        registered_at: '2026-01-01T00:00:00Z',
        last_heartbeat_at: '2026-01-01T00:00:00Z',
      },
    ],
  }));
  const claims = [
    {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'orc-1',
      state: 'claimed',
      claimed_at: '2026-01-01T00:00:00Z',
      lease_expires_at: '2099-01-01T00:00:00Z',
    },
    {
      run_id: 'run-2',
      task_ref: 'docs/task-2',
      agent_id: 'orc-1',
      state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00Z',
      lease_expires_at: '2099-01-01T00:00:00Z',
    },
  ];
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'events.jsonl'), '');
  seedProjectTasks(dir, [
    { ref: 'docs/task-1', title: 'Task 1', status: 'claimed' },
    { ref: 'docs/task-2', title: 'Task 2', status: 'in_progress' },
    { ref: 'docs/task-3', title: 'Task 3', status: 'done' },
  ], claims);
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('resetVolatileRuntimeStateForSession', () => {
  it('closes provider sessions on reset and restores their identities on rollback', () => {
    recordProviderSession(dir, {
      sessionId: 'session-master', runId: null, agentId: 'master', provider: 'claude', providerRef: null, startedAt: '2026-01-01T00:00:00Z',
    });
    const before = readAgents(dir).agents.find((agent) => agent.agent_id === 'master')?.session_token;
    expect(before).toBe('session-master');
    const reset = resetVolatileRuntimeStateForSession(dir);
    expect(readAgents(dir).agents.find((agent) => agent.agent_id === 'master')?.session_token).toBeNull();
    restoreVolatileRuntimeStateFromSnapshot(dir, reset.snapshot);
    expect(readAgents(dir).agents.find((agent) => agent.agent_id === 'master')?.session_token).toBe(before);
    // The reset closes the master's session and the rollback reopens it, each with its own event.
    expect(queryEvents(dir, {}).map((event) => event.event)).toEqual([
      'session_opened', 'run_failed', 'run_failed', 'session_state_changed', 'claim_created', 'run_started', 'session_state_changed',
    ]);
    const changes = queryEvents(dir, { event_type: 'session_state_changed' }).map((event) => event.payload);
    expect(changes).toMatchObject([
      { session_id: 'session-master', from: 'running', to: 'offline', reason: 'session closed' },
      { session_id: 'session-master', from: 'offline', to: 'running', reason: 'session reset rolled back' },
    ]);
  });

  it('resets active runtime state and appends a session_started event on demand', () => {
    const result = resetVolatileRuntimeStateForSession(dir);

    const backlog = readBacklog(dir);
    const claims = JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8')) as { claims: Array<{ state: string; failure_reason?: string }> };
    const agents = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')) as { agents: Array<{ agent_id: string; status: string; session_handle: string | null; provider_ref: unknown }> };

    expect(backlog.features[0].tasks.map((task) => [task.ref, task.status])).toEqual([
      ['docs/task-1', 'todo'],
      ['docs/task-2', 'todo'],
      ['docs/task-3', 'done'],
    ]);
    expect(claims.claims.map((claim) => [claim.state, claim.failure_reason])).toEqual([
      ['failed', 'session_reset'],
      ['failed', 'session_reset'],
    ]);
    expect(agents.agents.find((agent) => agent.agent_id === 'master')).toMatchObject({
      status: 'offline',
      session_handle: null,
      provider_ref: null,
    });
    expect(agents.agents.find((agent) => agent.agent_id === 'orc-1')).toMatchObject({
      status: 'idle',
      session_handle: null,
      provider_ref: null,
    });

    expect(result.reset_tasks).toBe(2);
    expect(result.reset_claims).toBe(2);
    expect(result.reset_agents).toBe(2);
    expect(result.session_id).toContain('session-');

    const beforeEvents = queryEvents(dir, {});
    expect(beforeEvents.map((event) => event.event)).toEqual(['run_failed', 'run_failed']);
    expect(beforeEvents.map((event) => event.payload)).toEqual([
      { reason: 'session_reset', code: 'ERR_SESSION_RESET', policy: 'requeue', task_status: 'todo', attempt_count: 0, requeue_eligible_after: null, blocked_reason: null },
      { reason: 'session_reset', code: 'ERR_SESSION_RESET', policy: 'requeue', task_status: 'todo', attempt_count: 0, requeue_eligible_after: null, blocked_reason: null },
    ]);

    const seq = appendSessionStartedEvent(dir, result);
    const events = queryEvents(dir, {});
    expect(events.at(-1)).toMatchObject({
      event: 'session_started',
      actor_type: 'human',
      actor_id: 'human',
      payload: {
        session_id: result.session_id,
        reset_tasks: 2,
        reset_claims: 2,
        reset_agents: 2,
      },
    });
    expect(events.at(-1)?.seq).toBe(seq);
  });
});

describe('crash recovery: kept state is adopted, reset stops what it closes', () => {
  function recordWorkerSession() {
    recordProviderSession(dir, {
      sessionId: 'session-orc-1', runId: null, agentId: 'orc-1', provider: 'codex', providerRef: null,
      startedAt: '2026-01-01T00:00:00Z', transport: 'tmux', processPid: 456, processStart: 'proc:456',
    });
  }

  it('a session start on kept state leaves the run in_progress and the coordinator adopts the live worker', async () => {
    recordWorkerSession();
    prepareSessionReuse(dir);

    const results = await reconcileSessions(dir, {
      owner: 'pid:2:new-coordinator',
      agents: readAgents(dir).agents,
      inspect: () => Promise.resolve({ transport: 'tmux', alive: true, writable: true, pid: 456, processStart: 'proc:456' }),
    });

    expect(results.find((result) => result.session_id === 'session-orc-1')).toMatchObject({ outcome: 'adopted', state: 'running' });
    expect(readClaims(dir).claims.find((claim) => claim.run_id === 'run-2')?.state).toBe('in_progress');
    expect(queryEvents(dir, { event_type: 'session_reconciled' }).some((event) =>
      (event.payload as { session_id: string; outcome?: string }).session_id === 'session-orc-1'
      && (event.payload as { outcome?: string }).outcome === 'adopted')).toBe(true);
  });

  it('stopSessionsForReset stops every non-master session before the reset closes it', async () => {
    recordWorkerSession();
    const stopped: string[] = [];
    const result = await stopSessionsForReset(dir, (agent) => { stopped.push(agent.session_handle!); return Promise.resolve(); });
    resetVolatileRuntimeStateForSession(dir);

    expect(stopped).toEqual(['tmux:orc-1']);
    expect(result).toEqual({ stopped: ['orc-1'], failed: [] });
    expect(readClaims(dir).claims.map((claim) => claim.state)).toEqual(['failed', 'failed']);
    expect(listSupervisedSessions(dir).find((row) => row.session_id === 'session-orc-1')?.state).toBe('offline');
  });

  it('stopSessionsForReset reports a failed stop instead of throwing', async () => {
    const result = await stopSessionsForReset(dir, () => Promise.reject(new Error('kill failed')));
    expect(result).toEqual({ stopped: [], failed: [{ agent_id: 'orc-1', error: 'kill failed' }] });
  });
});
