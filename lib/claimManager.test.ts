import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryEvents } from './eventLog.ts';
import {
  claimTask,
  startRun,
  heartbeat,
  finishRun,
  setRunFinalizationState,
  setRunInputState,
  expireStaleLeases,
  expireStaleLeasesDetailed,
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
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify(makeBacklog(tasks)));
  writeFileSync(join(dir, 'agents.json'),  JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'),  JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function readBacklog(dir: string): Backlog { return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')) as Backlog; }
function readClaims(dir: string)  { return JSON.parse(readFileSync(join(dir, 'claims.json'),  'utf8')) as { version: string; claims: Claim[] }; }
function readEvents(dir: string)  {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}

function pastDate(msAgo = 60_000) { return new Date(Date.now() - msAgo).toISOString(); }

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orch-claim-test-')); });
afterEach(()  => { rmSync(dir, { recursive: true, force: true }); });

// ── claimTask ──────────────────────────────────────────────────────────────

describe('claimTask', () => {
  it('returns run_id and lease_expires_at', () => {
    seed(dir);
    const { run_id, lease_expires_at } = claimTask(dir, 'orch/init', 'agent-01');
    expect(run_id).toMatch(/^run-/);
    expect(new Date(lease_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('sets task status to claimed in backlog.json', () => {
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
});

describe('setRunFinalizationState', () => {
  it('stores coordinator-owned finalize_rebase_requested state durably', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');

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
  it('sets claim to done and task to done on success', () => {
    seed(dir);
    const { run_id } = claimTask(dir, 'orch/init', 'agent-01');
    startRun(dir, run_id, 'agent-01');
    finishRun(dir, run_id, 'agent-01', { success: true });

    const claim = readClaims(dir).claims.find(c => c.run_id === run_id);
    expect(claim!.state).toBe('done');
    expect(claim!.finished_at).toBeTruthy();
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('done');
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
    seed(dir, {
      tasks: [
        { ...makeTask('orch/plan'), task_type: 'planning' as Task['task_type'] },
        { ...makeTask('orch/impl'), task_type: 'implementation' },
      ],
    });
    expect(nextEligibleTask(dir)).toBe('orch/impl');
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
    seed(dir, {
      tasks: [
        { ...makeTask('orch/a'), planning_state: 'proposal' as Task['planning_state'] },
        { ...makeTask('orch/b'), planning_state: 'ready_for_dispatch' },
      ],
    });
    expect(nextEligibleTask(dir)).toBe('orch/b');
  });

  it('routes only tasks matching required_capabilities', () => {
    const backlog = makeBacklog([
      { ...makeTask('orch/ai'), required_capabilities: ['ai'] },
      { ...makeTask('orch/ui'), required_capabilities: ['ui'] },
    ]);
    expect(nextEligibleTaskFromBacklog(backlog, { agent_id: 'worker-1', capabilities: ['ui'] } as import('../types/index.ts').Agent)).toBe('orch/ui');
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
