import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { queryEvents } from './eventLog.ts';
import { recordProviderSession } from './runStore.ts';
import { createTempStateDir, cleanupTempStateDir, seedState, readStateFile, readBacklog as readStoreBacklog } from '../test-fixtures/stateHelpers.ts';
import {
  claimTask,
  markTaskEnvelopeSent,
  startRun,
  heartbeat,
  renewLeaseOnly,
  finishRun,
  setRunFinalizationState,
  setRunInputState,
  setPrRef,
  setPrCreatedAt,
  expireStaleLeases,
  expireStaleLeasesDetailed,
  requeueBackoffMs,
} from './claimManager.ts';
import { nextEligibleTask, nextEligibleTaskFromBacklog } from './taskScheduler.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

import type { Task, Backlog, Claim } from '../types/index.ts';

function makeBacklog(tasks: Task[] = []): Backlog {
  return { version: '1', features: [{ ref: 'orch', title: 'Orch', tasks }] };
}

function makeTask(ref: string, status: Task['status'] = 'todo', deps: string[] = []): Task {
  return { ref, title: ref, status, depends_on: deps };
}

function seed(dir: string, { tasks = [makeTask('orch/init')], claims = [] as Claim[] } = {}) {
  seedState(dir, { tasks, claims });
}

function readBacklog(dir: string): Backlog { return readStoreBacklog(dir) as unknown as Backlog; }
function readClaims(dir: string) { return readStateFile<{ version: string; claims: Claim[] }>(dir, 'claims.json'); }
function readEvents(dir: string)  {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}

function pastDate(msAgo = 60_000) { return new Date(Date.now() - msAgo).toISOString(); }

let dir: string;
beforeEach(() => { dir = createTempStateDir('orch-claim-test-'); });
afterEach(()  => { cleanupTempStateDir(dir); });

// ── claimTask ──────────────────────────────────────────────────────────────

describe('claimTask', () => {
  it('returns run_id and lease_expires_at', () => {
    seed(dir);
    const { run_id, lease_expires_at } = claimTask(dir, 'orch/init', 'agent-01');
    expect(run_id).toMatch(/^run-/);
    expect(new Date(lease_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('sets task status to claimed in the project task store', () => {
    seed(dir);
    claimTask(dir, 'orch/init', 'agent-01');
    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.status).toBe('claimed');
  });

  it('appends claim entry to claims.json', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    const claim = readClaims(dir).claims.find(c => c.run_id === run_id);
    expect(claim).toBeTruthy();
    expect(claim!.agent_id).toBe('agent-01');
    expect(claim!.state).toBe('claimed');
  });

  it('emits claim_created event', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('claim_created');
    expect(events[0].run_id).toBe(run_id);
  });

  it('throws when task not found', () => {
    seed(dir);
    expect(() => claimTask(dir, 'orch/missing', 'agent-01')).toThrow('Task not found');
  });

  it('throws when task is not in todo state', () => {
    seed(dir, { tasks: [makeTask('orch/init', 'in_progress')] });
    expect(() => claimTask(dir, 'orch/init', 'agent-01')).toThrow('not claimable');
  });

  it('throws when task is already claimed', () => {
    seed(dir);
    claimTask(dir, 'orch/init', 'agent-01');
    // After first claim the task status is 'claimed' — second attempt hits the status guard.
    expect(() => claimTask(dir, 'orch/init', 'agent-02')).toThrow('not claimable');
  });

  it('throws when claiming agent is not task owner', () => {
    seed(dir, { tasks: [{ ...makeTask('orch/init'), owner: 'agent-owner' }] });
    expect(() => claimTask(dir, 'orch/init', 'agent-other')).toThrow('reserved for agent');
  });

  it('allows claim when claiming agent matches task owner', () => {
    seed(dir, { tasks: [{ ...makeTask('orch/init'), owner: 'agent-owner' }] });
    expect(() => claimTask(dir, 'orch/init', 'agent-owner')).not.toThrow();
  });

  it('respects custom leaseDurationMs', () => {
    seed(dir);
    const leaseDurationMs = 5 * 60 * 1000; // 5 minutes
    const { lease_expires_at } = claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs });
    const delta = new Date(lease_expires_at).getTime() - Date.now();
    expect(delta).toBeGreaterThan(4 * 60 * 1000);
    expect(delta).toBeLessThan(6 * 60 * 1000);
  });

  it('assigns sequential event seq numbers', () => {
    seed(dir, { tasks: [makeTask('orch/a'), makeTask('orch/b')] });
    claimTask(dir, 'orch/a', 'agent-01');
    claimTask(dir, 'orch/b', 'agent-02');
    const seqs = readEvents(dir).map(e => e.seq);
    expect(seqs).toEqual([1, 2]);
  });
});

// ── startRun ───────────────────────────────────────────────────────────────

describe('startRun', () => {
  it('transitions claim to in_progress', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    const claim = readClaims(dir).claims.find(c => c.run_id === run_id);
    expect(claim!.state).toBe('in_progress');
    expect(claim!.started_at).toBeTruthy();
  });

  it('sets task status to in_progress in backlog', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('in_progress');
  });

  it('emits run_started event', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    const ev = readEvents(dir).find(e => e.event === 'run_started');
    expect(ev).toBeTruthy();
    expect(ev!.run_id).toBe(run_id);
  });

  it('stamps run_started and run_finished with the run session id and generation', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    recordProviderSession(dir, {
      sessionId: 'sess-worker-1', runId: run_id, agentId: 'agent-01', provider: 'claude',
      providerRef: null, startedAt: new Date().toISOString(),
    });
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01');
    for (const name of ['run_started', 'run_finished']) {
      const ev = readEvents(dir).find(e => e.event === name);
      expect(ev?.payload).toMatchObject({ session_id: 'sess-worker-1', generation: 0 });
    }
  });

  it('throws when run_id not found', () => {
    seed(dir);
    expect(() => startRun(dir, 'run-nonexistent', 'agent-01')).toThrow('not found');
  });

  it('throws when wrong agent tries to start the run', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    expect(() => startRun(dir, run_id, 'agent-02')).toThrow('agent-01');
  });

  it('is idempotent — second call on an already in_progress claim is a no-op', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    const claimBefore = readClaims(dir).claims.find(c => c.run_id === run_id)!;
    const eventsBefore = readEvents(dir);
    // Second call must not throw and must not change state or emit a duplicate event
    expect(() => startRun(dir, run_id, 'agent-01')).not.toThrow();
    const claimAfter = readClaims(dir).claims.find(c => c.run_id === run_id)!;
    expect(claimAfter.state).toBe('in_progress');
    expect(claimAfter.started_at).toBe(claimBefore.started_at);
    expect(readEvents(dir)).toHaveLength(eventsBefore.length);
  });

  it('emits run_started with coordinator actor_type when actorType=coordinator', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01', { actorType: 'coordinator', actorId: 'coordinator' });
    const ev = readEvents(dir).find(e => e.event === 'run_started');
    expect(ev).toBeTruthy();
    expect(ev!.actor_type).toBe('coordinator');
    expect(ev!.actor_id).toBe('coordinator');
    expect(ev!.agent_id).toBe('agent-01');
  });
});

describe('markTaskEnvelopeSent', () => {
  it('records envelope delivery while leaving the claim in claimed state', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');

    markTaskEnvelopeSent(dir, run_id, 'agent-01');

    const claim = readClaims(dir).claims.find(c => c.run_id === run_id);
    expect(claim!.state).toBe('claimed');
    expect(claim!.task_envelope_sent_at).toBeTruthy();
    expect(claim!.started_at).toBeNull();

    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.status).toBe('claimed');

    const ev = readEvents(dir).find(e => e.event === 'task_envelope_sent');
    expect(ev).toBeTruthy();
    expect(ev!.run_id).toBe(run_id);
  });

  it('is idempotent for duplicate delivery records', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');

    markTaskEnvelopeSent(dir, run_id, 'agent-01');
    const claimBefore = readClaims(dir).claims.find(c => c.run_id === run_id)!;
    const eventsBefore = readEvents(dir);

    expect(() => markTaskEnvelopeSent(dir, run_id, 'agent-01')).not.toThrow();

    const claimAfter = readClaims(dir).claims.find(c => c.run_id === run_id)!;
    expect(claimAfter.task_envelope_sent_at).toBe(claimBefore.task_envelope_sent_at);
    expect(readEvents(dir)).toHaveLength(eventsBefore.length);
  });
});

// ── heartbeat ──────────────────────────────────────────────────────────────

describe('heartbeat', () => {
  it('renews the lease', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs: 5 * 60 * 1000 });
    const { lease_expires_at } = heartbeat(dir, run_id, 'agent-01', { leaseDurationMs: 30 * 60 * 1000 });
    const delta = new Date(lease_expires_at).getTime() - Date.now();
    expect(delta).toBeGreaterThan(29 * 60 * 1000);
  });

  it('updates last_heartbeat_at in claims.json', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    heartbeat(dir, run_id, 'agent-01');
    const claim = readClaims(dir).claims.find(c => c.run_id === run_id);
    expect(claim!.last_heartbeat_at).toBeTruthy();
  });

  it('emits heartbeat event', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    heartbeat(dir, run_id, 'agent-01');
    const ev = readEvents(dir).find(e => e.event === 'heartbeat');
    expect(ev).toBeTruthy();
  });

  it('throws for unknown run_id', () => {
    seed(dir);
    expect(() => heartbeat(dir, 'run-nope', 'agent-01')).toThrow('not found');
  });

  it('throws when wrong agent heartbeats the run', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    expect(() => heartbeat(dir, run_id, 'agent-02')).toThrow('agent-01');
  });

  it('throws when claim is already done', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: true });
    expect(() => heartbeat(dir, run_id, 'agent-01')).toThrow('done');
  });

  it('can renew lease without emitting heartbeat event', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    heartbeat(dir, run_id, 'agent-01', { emitEvent: false });
    expect(readEvents(dir).some((e) => e.event === 'heartbeat')).toBe(false);
  });

  it('throws when lease has already expired', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs: 60_000 });
    startRun(dir, run_id, 'agent-01');
    // Use an `at` timestamp 2 minutes in the future — past the 1-minute lease
    const futureAt = new Date(Date.now() + 120_000).toISOString();
    expect(() => heartbeat(dir, run_id, 'agent-01', { at: futureAt })).toThrow('expired');
  });
});

describe('renewLeaseOnly', () => {
  it('renews to the given duration but never shortens a longer lease', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs: 5 * 60 * 1000 });
    startRun(dir, run_id, 'agent-01');
    renewLeaseOnly(dir, run_id, { leaseDurationMs: 10 * 60 * 1000 });
    const lease = () => Date.parse(readClaims(dir).claims.find((c) => c.run_id === run_id)!.lease_expires_at) - Date.now();
    expect(lease()).toBeGreaterThan(9 * 60 * 1000);
    heartbeat(dir, run_id, 'agent-01', { leaseDurationMs: 60 * 60 * 1000 });
    renewLeaseOnly(dir, run_id, { leaseDurationMs: 10 * 60 * 1000 });
    expect(lease()).toBeGreaterThan(59 * 60 * 1000);
  });
});

describe('setRunFinalizationState', () => {
  it('stores coordinator-owned finalize_rebase_requested state durably', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    setRunFinalizationState(dir, run_id, 'agent-01', { finalizationState: 'awaiting_finalize' });

    setRunFinalizationState(dir, run_id, 'agent-01', {
      finalizationState: 'finalize_rebase_requested',
      retryCountDelta: 0,
      blockedReason: null,
    });

    const claim = readClaims(dir).claims.find((entry) => entry.run_id === run_id);
    expect(claim!.finalization_state).toBe('finalize_rebase_requested');
    expect(claim!.finalization_retry_count).toBe(0);
    expect(claim!.finalization_blocked_reason).toBeNull();
  });

  it('rejects unsupported finalization states', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');

    expect(() => setRunFinalizationState(dir, run_id, 'agent-01', {
      finalizationState: 'merge-now' as unknown as import('../types/index.ts').FinalizationState,
    })).toThrow('Unsupported finalization state');
  });
});

describe('finalization transition graph', () => {
  function startedRun() {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    return run_id;
  }
  const move = (runId: string, to: import('../types/index.ts').FinalizationState) =>
    setRunFinalizationState(dir, runId, 'agent-01', { finalizationState: to });

  it('rejects an illegal transition and leaves the state unchanged', () => {
    const runId = startedRun();
    expect(() => move(runId, 'ready_to_merge')).toThrow('Illegal finalization transition');
    move(runId, 'awaiting_finalize');
    move(runId, 'pr_created');
    move(runId, 'pr_review_in_progress');
    move(runId, 'pr_merged');
    expect(() => move(runId, 'awaiting_finalize')).toThrow('pr_merged → awaiting_finalize');
    expect(readClaims(dir).claims.find((c) => c.run_id === runId)!.finalization_state).toBe('pr_merged');
  });

  it('allows ready_to_merge to return to finalize_rebase_requested after a merge failure', () => {
    const runId = startedRun();
    for (const state of ['awaiting_finalize', 'finalize_rebase_requested', 'finalize_rebase_in_progress', 'ready_to_merge', 'finalize_rebase_requested'] as const) {
      move(runId, state);
    }
    expect(readClaims(dir).claims.find((c) => c.run_id === runId)!.finalization_state).toBe('finalize_rebase_requested');
  });

  it('allows rewriting the current state (retry bump)', () => {
    const runId = startedRun();
    move(runId, 'awaiting_finalize');
    move(runId, 'awaiting_finalize');
  });
});

describe('setRunInputState', () => {
  it('stores awaiting_input durably on an in-progress claim', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');

    setRunInputState(dir, run_id, 'agent-01', {
      inputState: 'awaiting_input',
      requestedAt: '2026-03-11T08:00:00.000Z',
    });

    const claim = readClaims(dir).claims.find((entry) => entry.run_id === run_id);
    expect(claim!.input_state).toBe('awaiting_input');
    expect(claim!.input_requested_at).toBe('2026-03-11T08:00:00.000Z');
  });
});

// ── finishRun ──────────────────────────────────────────────────────────────

describe('finishRun', () => {
  it('repairs stale finalization fields on a matching terminal retry without changing the task', () => {
    seed(dir, {
      tasks: [makeTask('orch/init', 'done')],
      claims: [{
        run_id: 'run-old', task_ref: 'orch/init', agent_id: 'agent-01', state: 'failed',
        claimed_at: pastDate(), lease_expires_at: pastDate(), finished_at: pastDate(),
        finalization_state: 'blocked_finalize', finalization_retry_count: 3,
        finalization_blocked_reason: 'old retry timeout',
      }],
    });

    finishRun(dir, 'run-old', 'agent-01', { success: false });

    expect(readClaims(dir).claims[0]).toMatchObject({
      state: 'failed', finalization_state: null, finalization_retry_count: 0,
      finalization_blocked_reason: null,
    });
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('done');
    expect(readEvents(dir)).toHaveLength(0);
  });

  it('sets claim to done and leaves the task in_progress for the merge confirmation on success', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: true });

    const claim = readClaims(dir).claims.find(c => c.run_id === run_id);
    expect(claim!.state).toBe('done');
    expect(claim!.finished_at).toBeTruthy();
    // The project store records done only from the coordinator's merge confirmation.
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('in_progress');
  });

  it('emits run_finished event on success', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: true });
    const ev = readEvents(dir).find(e => e.event === 'run_finished');
    expect(ev).toBeTruthy();
  });

  it('requeues task to todo on failure with default policy', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: false });
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('todo');
  });

  it('blocks task on failure with policy=block', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: false, policy: 'block' });
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('blocked');
  });

  it('emits run_failed event on failure', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: false, failureReason: 'timeout' });
    const ev = readEvents(dir).find(e => e.event === 'run_failed');
    expect((ev?.payload as Record<string, unknown>)?.reason).toBe('timeout');
  });

  it('throws when wrong agent finishes the run', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    expect(() => finishRun(dir, run_id, 'agent-02', { success: true })).toThrow('agent-01');
  });

  it('allows requeued task to be claimed again', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: false }); // requeue
    expect(() => claimTask(dir, 'orch/init', 'agent-02')).not.toThrow();
  });

  it('increments attempt_count on genuine execution failure', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: false, failureCode: 'ERR_RUN_INACTIVITY_TIMEOUT' });
    expect(readBacklog(dir).features[0].tasks[0].attempt_count).toBe(1);
  });

  it('does NOT increment attempt_count on ERR_DISPATCH_FAILURE', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: false, failureCode: 'ERR_DISPATCH_FAILURE' });
    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.attempt_count ?? 0).toBe(0);
    expect(task.status).toBe('todo');
  });

  it('does NOT increment attempt_count on ERR_RUN_START_TIMEOUT', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: false, failureCode: 'ERR_RUN_START_TIMEOUT' });
    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.attempt_count ?? 0).toBe(0);
    expect(task.status).toBe('todo');
  });

  it('does NOT increment attempt_count on ERR_SESSION_START_FAILED', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: false, failureCode: 'ERR_SESSION_START_FAILED' });
    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.attempt_count ?? 0).toBe(0);
    expect(task.status).toBe('todo');
  });

  it('does NOT block task on repeated infra failures (attempt_count stays 0)', () => {
    seed(dir);
    // Simulate 10 infra failures — should never hit MAX_ATTEMPTS
    for (let i = 0; i < 10; i++) {
      const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
      startRun(dir, run_id, 'agent-01');
      finishRun(dir, run_id, 'agent-01', { success: false, failureCode: 'ERR_DISPATCH_FAILURE' });
    }
    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.attempt_count ?? 0).toBe(0);
    expect(task.status).toBe('todo');
  });
});

describe('setRunFinalizationState', () => {
  it('stores awaiting_finalize durably without completing the run', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');

    setRunFinalizationState(dir, run_id, 'agent-01', {
      finalizationState: 'awaiting_finalize',
      blockedReason: null,
    });

    const claim = readClaims(dir).claims.find((candidate) => candidate.run_id === run_id);
    expect(claim!.state).toBe('in_progress');
    expect(claim!.finalization_state).toBe('awaiting_finalize');
    expect(claim!.finalization_retry_count).toBe(0);
    expect(claim!.finalization_blocked_reason).toBeNull();
  });

  it('increments finalization retry count when finalize rebase starts', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    setRunFinalizationState(dir, run_id, 'agent-01', {
      finalizationState: 'awaiting_finalize',
      blockedReason: null,
    });

    setRunFinalizationState(dir, run_id, 'agent-01', { finalizationState: 'finalize_rebase_requested' });
    setRunFinalizationState(dir, run_id, 'agent-01', {
      finalizationState: 'finalize_rebase_in_progress',
      retryCountDelta: 1,
      blockedReason: null,
    });

    const claim = readClaims(dir).claims.find((candidate) => candidate.run_id === run_id);
    expect(claim!.finalization_state).toBe('finalize_rebase_in_progress');
    expect(claim!.finalization_retry_count).toBe(1);
  });
});

describe('finalization_changed events', () => {
  it('emits one event per finalization change, including blocked_finalize with its reason', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    setRunFinalizationState(dir, run_id, 'agent-01', { finalizationState: 'awaiting_finalize' });
    setRunFinalizationState(dir, run_id, 'agent-01', {
      finalizationState: 'blocked_finalize',
      blockedReason: 'merge conflict on main',
    });

    const events = readEvents(dir).filter((e) => e.event === 'finalization_changed');
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      run_id, task_ref: 'orch/init', agent_id: 'agent-01', actor_type: 'coordinator',
      payload: {
        from: 'awaiting_finalize', to: 'blocked_finalize', retry_count: 0,
        blocked_reason: 'merge conflict on main', pr_ref: null, pr_created_at: null,
      },
    });
  });

  it('reports a retry-count change and skips a write that changes nothing', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    setRunFinalizationState(dir, run_id, 'agent-01', { finalizationState: 'awaiting_finalize' });
    setRunFinalizationState(dir, run_id, 'agent-01', { finalizationState: 'finalize_rebase_requested' });
    setRunFinalizationState(dir, run_id, 'agent-01', { finalizationState: 'finalize_rebase_requested' });
    setRunFinalizationState(dir, run_id, 'agent-01', { finalizationState: 'finalize_rebase_requested', retryCountDelta: 1 });

    expect(readEvents(dir).filter((e) => e.event === 'finalization_changed').map((e) => e.payload)).toEqual([
      expect.objectContaining({ from: null, to: 'awaiting_finalize', retry_count: 0 }),
      expect.objectContaining({ from: 'awaiting_finalize', to: 'finalize_rebase_requested', retry_count: 0 }),
      expect.objectContaining({ from: 'finalize_rebase_requested', to: 'finalize_rebase_requested', retry_count: 1 }),
    ]);
  });

  it('carries the PR fields recorded before the change', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    setPrRef(dir, run_id, 'https://example.test/pr/7');
    setPrCreatedAt(dir, run_id, '2026-01-02T00:00:00.000Z');
    setRunFinalizationState(dir, run_id, 'agent-01', { finalizationState: 'awaiting_finalize' });
    setRunFinalizationState(dir, run_id, 'agent-01', { finalizationState: 'pr_created' });

    expect(readEvents(dir).filter((e) => e.event === 'finalization_changed')[1].payload).toMatchObject({
      to: 'pr_created', pr_ref: 'https://example.test/pr/7', pr_created_at: '2026-01-02T00:00:00.000Z',
    });
  });
});

describe('failure outcome in run_failed and claim_expired', () => {
  it('reports task_status blocked on the fifth failed attempt', () => {
    seed(dir);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
      startRun(dir, run_id, 'agent-01');
      finishRun(dir, run_id, 'agent-01', { success: false, failureReason: `attempt ${attempt}` });
    }
    const failed = readEvents(dir).filter((e) => e.event === 'run_failed');
    expect(failed).toHaveLength(5);
    expect(failed[3].payload).toMatchObject({ policy: 'requeue', task_status: 'todo', attempt_count: 4, blocked_reason: null });
    expect(failed[3].payload.requeue_eligible_after).toEqual(expect.any(String));
    expect(failed[4].payload).toMatchObject({
      policy: 'requeue', task_status: 'blocked', attempt_count: 5,
      blocked_reason: 'max_attempts_exceeded: failed 5 times',
    });
  });

  it('reports the block reason of a run failed with policy block', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: false, failureReason: 'spec is contradictory', policy: 'block' });
    expect(readEvents(dir).find((e) => e.event === 'run_failed').payload).toMatchObject({
      policy: 'block', task_status: 'blocked', blocked_reason: 'spec is contradictory',
    });
  });

  it('gives lease-expiry claim_expired the agent_id and the resulting task fields', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs: -1000 });
    expireStaleLeases(dir);
    const ev = readEvents(dir).find((e) => e.event === 'claim_expired');
    expect(ev).toMatchObject({ run_id, agent_id: 'agent-01' });
    expect(ev.payload).toEqual({
      policy: 'requeue', code: 'ERR_LEASE_EXPIRED', reason: 'ERR_LEASE_EXPIRED',
      task_status: 'todo', attempt_count: 1, requeue_eligible_after: expect.any(String), blocked_reason: null,
    });
  });
});

// ── expireStaleLeases ──────────────────────────────────────────────────────

describe('expireStaleLeases', () => {
  it('returns empty array when no leases are expired', () => {
    seed(dir);
    claimTask(dir, 'orch/init', 'agent-01'); // future lease
    expect(expireStaleLeases(dir)).toEqual([]);
  });

  it('expires claims with past lease_expires_at', () => {
    seed(dir);
    claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs: -1000 }); // already expired
    const expired = expireStaleLeases(dir);
    expect(expired).toHaveLength(1);
  });

  it('requeues task by default when lease expires', () => {
    seed(dir);
    claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs: -1000 });
    expireStaleLeases(dir);
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('todo');
  });

  it('blocks task when policy=block', () => {
    seed(dir);
    claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs: -1000 });
    expireStaleLeases(dir, { policy: 'block' });
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('blocked');
  });

  it('emits claim_expired event for each expired claim', () => {
    seed(dir);
    claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs: -1000 });
    expireStaleLeases(dir);
    const ev = readEvents(dir).find(e => e.event === 'claim_expired');
    expect(ev).toBeTruthy();
  });

  it('does not touch claims with future lease', () => {
    seed(dir, { tasks: [makeTask('orch/a'), makeTask('orch/b')] });
    claimTask(dir, 'orch/a', 'agent-01', { leaseDurationMs: -1000 });  // expired
    claimTask(dir, 'orch/b', 'agent-02');                               // fresh
    const expired = expireStaleLeases(dir);
    expect(expired).toHaveLength(1);
    expect(readBacklog(dir).features[0].tasks.find(t => t.ref === 'orch/b')!.status).toBe('claimed');
  });

  it('allows expired task to be reclaimed after requeue', () => {
    seed(dir);
    claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs: -1000 });
    expireStaleLeases(dir);
    expect(() => claimTask(dir, 'orch/init', 'agent-02')).not.toThrow();
  });

  it('returns expired run details for coordinator-owned cleanup', () => {
    seed(dir);
    claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs: -1000 });
    expect(expireStaleLeasesDetailed(dir)).toEqual([
      expect.objectContaining({
        run_id: expect.stringMatching(/^run-/),
        task_ref: 'orch/init',
        agent_id: 'agent-01',
      }),
    ]);
  });

  it('does not expire a run that is intentionally awaiting input', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    setRunInputState(dir, run_id, 'agent-01', {
      inputState: 'awaiting_input',
      requestedAt: new Date().toISOString(),
    });
    const claims = readClaims(dir);
    claims.claims[0].lease_expires_at = pastDate(5_000);
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(claims));

    expect(expireStaleLeases(dir)).toEqual([]);
    expect(expireStaleLeasesDetailed(dir)).toEqual([]);
    const claim = readClaims(dir).claims[0];
    expect(claim.state).toBe('in_progress');
    expect(claim.input_state).toBe('awaiting_input');
  });

  it('does not expire awaiting_input claims within INPUT_WAIT_TIMEOUT_MS', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    // input requested just now — well within the 1-hour timeout
    setRunInputState(dir, run_id, 'agent-01', {
      inputState: 'awaiting_input',
      requestedAt: new Date().toISOString(),
    });
    // expire the normal lease
    const claims = readClaims(dir);
    claims.claims[0].lease_expires_at = pastDate(5_000);
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(claims));

    expect(expireStaleLeases(dir)).toEqual([]);
    const claim = readClaims(dir).claims[0];
    expect(claim.state).toBe('in_progress');
    expect(claim.input_state).toBe('awaiting_input');
  });

  it('expires awaiting_input claims exceeding INPUT_WAIT_TIMEOUT_MS with ERR_INPUT_TIMEOUT', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    // input requested over 1 hour ago
    const oldRequestedAt = new Date(Date.now() - 3_600_001).toISOString();
    setRunInputState(dir, run_id, 'agent-01', {
      inputState: 'awaiting_input',
      requestedAt: oldRequestedAt,
    });
    const claims = readClaims(dir);
    claims.claims[0].lease_expires_at = pastDate(5_000);
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(claims));

    const expired = expireStaleLeases(dir);
    expect(expired).toEqual([run_id]);

    const claim = readClaims(dir).claims[0];
    expect(claim.state).toBe('failed');
    expect(claim.failure_reason).toBe('ERR_INPUT_TIMEOUT');
    expect(claim.input_state).toBeNull();

    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.status).toBe('todo');

    const ev = readEvents(dir).find(e => e.event === 'claim_expired');
    expect(ev).toBeDefined();
    expect(ev.payload.code).toBe('ERR_INPUT_TIMEOUT');
  });

  it('allows awaiting-input state to be recorded before run_start for claimed runs', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');

    setRunInputState(dir, run_id, 'agent-01', {
      inputState: 'awaiting_input',
      requestedAt: new Date().toISOString(),
    });

    const claim = readClaims(dir).claims[0];
    expect(claim.state).toBe('claimed');
    expect(claim.input_state).toBe('awaiting_input');
    expect(claim.input_requested_at).toBeTruthy();
  });
});

// ── nextEligibleTask ───────────────────────────────────────────────────────

describe('nextEligibleTask', () => {
  it('returns first todo task with no unmet dependencies', () => {
    seed(dir, { tasks: [makeTask('orch/a'), makeTask('orch/b')] });
    expect(nextEligibleTask(dir)).toBe('orch/a');
  });

  it('returns null when no todo tasks', () => {
    seed(dir, { tasks: [makeTask('orch/a', 'done')] });
    expect(nextEligibleTask(dir)).toBeNull();
  });

  it('skips tasks with unmet dependencies', () => {
    seed(dir, { tasks: [makeTask('orch/a', 'todo', ['orch/b']), makeTask('orch/b', 'todo')] });
    // orch/a depends on orch/b which is still todo — not eligible
    // orch/b has no deps — eligible
    expect(nextEligibleTask(dir)).toBe('orch/b');
  });

  it('returns task once its dependency is done', () => {
    seed(dir, { tasks: [makeTask('orch/a', 'todo', ['orch/b']), makeTask('orch/b', 'done')] });
    expect(nextEligibleTask(dir)).toBe('orch/a');
  });

  it('enforces owner assignment for agent-scoped selection', () => {
    seed(dir, {
      tasks: [
        { ...makeTask('orch/a'), owner: 'lisa' },
        { ...makeTask('orch/b'), owner: 'bob' },
      ],
    });
    expect(nextEligibleTask(dir, 'bob')).toBe('orch/b');
    expect(nextEligibleTask(dir, 'lisa')).toBe('orch/a');
  });

  it('returns null when only tasks owned by a different agent are todo', () => {
    seed(dir, {
      tasks: [{ ...makeTask('orch/a'), owner: 'lisa' }],
    });
    expect(nextEligibleTask(dir, 'dave')).toBeNull();
  });

  it('skips unknown task types and selects known dispatchable task', () => {
    // The project store rejects unknown task types, so model the backlog in memory.
    const backlog = makeBacklog([
      { ...makeTask('orch/plan'), task_type: 'planning' as Task['task_type'] },
      { ...makeTask('orch/impl'), task_type: 'implementation' },
    ]);
    expect(nextEligibleTaskFromBacklog(backlog)).toBe('orch/impl');
  });

  it('does not route unknown task types to any agent', () => {
    const backlog = makeBacklog([
      { ...makeTask('orch/review'), task_type: 'review' as Task['task_type'] },
      { ...makeTask('orch/impl'), task_type: 'implementation' },
    ]);
    expect(nextEligibleTaskFromBacklog(backlog, { agent_id: 'rev-1', role: 'reviewer', capabilities: [] } as unknown as import('../types/index.ts').Agent))
      .toBe('orch/impl');
    expect(nextEligibleTaskFromBacklog(backlog, { agent_id: 'wrk-1', role: 'worker', capabilities: [] } as unknown as import('../types/index.ts').Agent))
      .toBe('orch/impl');
  });

  it('requires planning_state=ready_for_dispatch when planning_state is present', () => {
    // The project store accepts only ready_for_dispatch/archived, so model the backlog in memory.
    const backlog = makeBacklog([
      { ...makeTask('orch/a'), planning_state: 'proposal' as Task['planning_state'] },
      { ...makeTask('orch/b'), planning_state: 'ready_for_dispatch' },
    ]);
    expect(nextEligibleTaskFromBacklog(backlog)).toBe('orch/b');
  });
});

describe('nextEligibleTaskFromBacklog', () => {
  it('routes owner-assigned work only to the matching agent', () => {
    const backlog = makeBacklog([
      { ...makeTask('orch/a'), owner: 'alice' },
      { ...makeTask('orch/b'), owner: 'bob' },
    ]);
    expect(nextEligibleTaskFromBacklog(backlog, 'alice')).toBe('orch/a');
    expect(nextEligibleTaskFromBacklog(backlog, 'bob')).toBe('orch/b');
  });
});

// ── requeue backoff ────────────────────────────────────────────────────────

describe('requeue backoff — finishRun', () => {
  it('sets requeue_eligible_after on first genuine failure', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    const before = Date.now();
    finishRun(dir, run_id, 'agent-01', { success: false });
    const after = Date.now();

    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.status).toBe('todo');
    expect(task.requeue_eligible_after).toBeTruthy();
    const eligible = new Date(task.requeue_eligible_after!).getTime();
    // attempt_count=1 → backoff=30s
    expect(eligible).toBeGreaterThanOrEqual(before + 30_000);
    expect(eligible).toBeLessThanOrEqual(after  + 30_000);
  });

  it('doubles backoff on second failure (60s)', () => {
    seed(dir, { tasks: [{ ...makeTask('orch/init'), attempt_count: 1 }] });
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    const before = Date.now();
    finishRun(dir, run_id, 'agent-01', { success: false });
    const after = Date.now();

    const task = readBacklog(dir).features[0].tasks[0];
    const eligible = new Date(task.requeue_eligible_after!).getTime();
    // attempt_count=2 → backoff=60s
    expect(eligible).toBeGreaterThanOrEqual(before + 60_000);
    expect(eligible).toBeLessThanOrEqual(after  + 60_000);
  });

  it('caps backoff at 600 000 ms regardless of attempt count', () => {
    // requeueBackoffMs is exported so we can test the cap formula directly
    // (end-to-end cap is unreachable with current MAX_ATTEMPTS=5, but the
    //  formula must enforce the guard for future MAX_ATTEMPTS increases)
    expect(requeueBackoffMs(1)).toBe(30_000);
    expect(requeueBackoffMs(2)).toBe(60_000);
    expect(requeueBackoffMs(3)).toBe(120_000);
    expect(requeueBackoffMs(4)).toBe(240_000);
    expect(requeueBackoffMs(5)).toBe(480_000);
    expect(requeueBackoffMs(6)).toBe(600_000); // would be 960 000 — capped
    expect(requeueBackoffMs(100)).toBe(600_000);
  });

  it('does NOT set requeue_eligible_after for infra failures', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: false, failureCode: 'ERR_DISPATCH_FAILURE' });
    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.requeue_eligible_after).toBeUndefined();
  });

  it('does NOT set requeue_eligible_after on policy=block', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: false, policy: 'block' });
    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.requeue_eligible_after).toBeUndefined();
  });

  it('does NOT set requeue_eligible_after on success', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: true });
    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.requeue_eligible_after).toBeUndefined();
  });
});

describe('requeue backoff — expireStaleLeases', () => {
  it('sets requeue_eligible_after when a lease expires and task is requeued', () => {
    seed(dir);
    claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs: -1000 });
    const before = Date.now();
    expireStaleLeases(dir);
    const after = Date.now();

    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.status).toBe('todo');
    expect(task.requeue_eligible_after).toBeTruthy();
    const eligible = new Date(task.requeue_eligible_after!).getTime();
    expect(eligible).toBeGreaterThanOrEqual(before + 30_000);
    expect(eligible).toBeLessThanOrEqual(after  + 30_000);
  });

  it('does NOT set requeue_eligible_after when policy=block on expiry', () => {
    seed(dir);
    claimTask(dir, 'orch/init', 'agent-01', { leaseDurationMs: -1000 });
    expireStaleLeases(dir, { policy: 'block' });
    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.requeue_eligible_after).toBeUndefined();
  });
});

describe('requeue backoff — task scheduler skips', () => {
  it('skips a task that is in its backoff window', () => {
    const futureEligible = new Date(Date.now() + 60_000).toISOString();
    const bl = makeBacklog([
      { ...makeTask('orch/a'), requeue_eligible_after: futureEligible },
      { ...makeTask('orch/b') },
    ]);
    expect(nextEligibleTaskFromBacklog(bl, null)).toBe('orch/b');
  });

  it('dispatches a task whose backoff window has elapsed', () => {
    const pastEligible = new Date(Date.now() - 1000).toISOString();
    const bl = makeBacklog([
      { ...makeTask('orch/a'), requeue_eligible_after: pastEligible },
    ]);
    expect(nextEligibleTaskFromBacklog(bl, null)).toBe('orch/a');
  });

  it('returns null when all todo tasks are in backoff', () => {
    const futureEligible = new Date(Date.now() + 60_000).toISOString();
    const bl = makeBacklog([
      { ...makeTask('orch/a'), requeue_eligible_after: futureEligible },
    ]);
    expect(nextEligibleTaskFromBacklog(bl, null)).toBeNull();
  });
});
