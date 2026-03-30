import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { queryEvents } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-lifecycle-edge-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runCli(script: string, args: string[] = []) {
  return spawnSync('node', ['--experimental-strip-types', `cli/${script}`, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function readEvents(): Array<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}

function readClaims(): { claims: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8'));
}

function claimSnapshot(runId: string): Record<string, unknown> | undefined {
  return readClaims().claims.find((c) => c.run_id === runId);
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

function seedClaimedRun({ runId = 'run-test-001', agentId = 'worker-01', taskRef = 'docs/task-1' } = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: taskRef, title: 'Task 1', status: 'claimed' }] }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{
      agent_id: agentId,
      provider: 'claude',
      status: 'running',
      session_token: 'session-token-1',
      session_started_at: '2026-01-01T00:00:00.000Z',
      session_ready_at: null,
      registered_at: '2026-01-01T00:00:00Z',
    }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: [{
      run_id: runId,
      task_ref: taskRef,
      agent_id: agentId,
      state: 'claimed',
      claimed_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: '2099-01-01T00:00:00.000Z',
      last_heartbeat_at: null,
      started_at: null,
      finished_at: null,
    }],
  }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function seedInProgressRun({ runId = 'run-test-001', agentId = 'worker-01', taskRef = 'docs/task-1', finalizationState = null as string | null } = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: taskRef, title: 'Task 1', status: 'in_progress' }] }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{
      agent_id: agentId,
      provider: 'claude',
      status: 'running',
      registered_at: '2026-01-01T00:00:00Z',
    }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: [{
      run_id: runId,
      task_ref: taskRef,
      agent_id: agentId,
      state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:01:00.000Z',
      lease_expires_at: '2099-01-01T00:00:00.000Z',
      last_heartbeat_at: null,
      finished_at: null,
      finalization_state: finalizationState,
      finalization_retry_count: 0,
      finalization_blocked_reason: null,
    }],
  }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function markTaskDone(taskRef = 'docs/task-1') {
  const backlog = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
  for (const feature of backlog.features) {
    const task = feature.tasks.find((t: { ref: string }) => t.ref === taskRef);
    if (task) task.status = 'done';
  }
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog));
}

// ── Agent-ID mismatch ────────────────────────────────────────────────────────
//
// All lifecycle commands must reject when the caller's agent-id does not match
// the claim owner. No event should be emitted in any of these cases.

describe('agent-id mismatch', () => {
  it('run-start rejects and emits no event when agent-id does not own the claim', () => {
    seedClaimedRun({ runId: 'run-mismatch-start', agentId: 'worker-01' });

    const result = runCli('run-start.ts', ['--run-id=run-mismatch-start', '--agent-id=worker-99']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('worker-01');
    expect(readEvents().some((e) => e.event === 'run_started')).toBe(false);
    expect(claimSnapshot('run-mismatch-start')?.state).toBe('claimed');
  });

  it('run-heartbeat rejects and emits no event when agent-id does not own the claim', () => {
    seedInProgressRun({ runId: 'run-mismatch-hb', agentId: 'worker-01' });

    const result = runCli('run-heartbeat.ts', ['--run-id=run-mismatch-hb', '--agent-id=worker-99']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('worker-01');
    expect(readEvents().some((e) => e.event === 'heartbeat')).toBe(false);
  });

  it('run-work-complete rejects and emits no event when agent-id does not own the claim', () => {
    seedInProgressRun({ runId: 'run-mismatch-wc', agentId: 'worker-01' });
    markTaskDone();

    const result = runCli('run-work-complete.ts', ['--run-id=run-mismatch-wc', '--agent-id=worker-99']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('worker-01');
    expect(readEvents().some((e) => e.event === 'work_complete')).toBe(false);
  });

  it('run-finish rejects and emits no event when agent-id does not own the claim', () => {
    seedInProgressRun({ runId: 'run-mismatch-finish', agentId: 'worker-01' });

    const result = runCli('run-finish.ts', ['--run-id=run-mismatch-finish', '--agent-id=worker-99']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('worker-01');
    expect(readEvents().some((e) => e.event === 'run_finished')).toBe(false);
  });

  it('run-fail rejects and emits no event when agent-id does not own the claim', () => {
    seedInProgressRun({ runId: 'run-mismatch-fail', agentId: 'worker-01' });

    const result = runCli('run-fail.ts', ['--run-id=run-mismatch-fail', '--agent-id=worker-99', '--reason=oops']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('worker-01');
    expect(readEvents().some((e) => e.event === 'run_failed')).toBe(false);
  });
});

// ── run-heartbeat: expired lease (Task 61 rejection behavior) ────────────────
//
// Heartbeat must be rejected when the lease has expired, regardless of the
// claim state. The worker-coordinator protocol relies on this to ensure stale
// workers do not extend leases for tasks already requeued by the coordinator.

describe('run-heartbeat expired lease', () => {
  it('rejects heartbeat when the claim is in_progress but lease has expired and run was requeued', () => {
    // Simulates a worker that missed heartbeats: claim is in_progress but expired.
    // The coordinator would have requeued the task; the worker still tries to heartbeat.
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
      version: '1',
      features: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }] }],
    }));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{ agent_id: 'worker-01', provider: 'claude', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
    }));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({
      version: '1',
      claims: [{
        run_id: 'run-expired-requeued',
        task_ref: 'docs/task-1',
        agent_id: 'worker-01',
        state: 'in_progress',
        claimed_at: '2020-01-01T00:00:00.000Z',
        started_at: '2020-01-01T00:01:00.000Z',
        lease_expires_at: '2020-01-01T00:31:00.000Z',
        last_heartbeat_at: null,
        finished_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    }));
    writeFileSync(join(dir, 'events.jsonl'), '');

    const result = runCli('run-heartbeat.ts', ['--run-id=run-expired-requeued', '--agent-id=worker-01']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expired');
    expect(readEvents().some((e) => e.event === 'heartbeat' && e.run_id === 'run-expired-requeued')).toBe(false);
  });

  it('rejects heartbeat when the claim state is done (run already completed)', () => {
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
      version: '1',
      features: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'done' }] }],
    }));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{ agent_id: 'worker-01', provider: 'claude', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
    }));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({
      version: '1',
      claims: [{
        run_id: 'run-done-hb',
        task_ref: 'docs/task-1',
        agent_id: 'worker-01',
        state: 'done',
        claimed_at: '2026-01-01T00:00:00.000Z',
        started_at: '2026-01-01T00:01:00.000Z',
        finished_at: '2026-01-01T00:10:00.000Z',
        lease_expires_at: '2099-01-01T00:00:00.000Z',
        last_heartbeat_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    }));
    writeFileSync(join(dir, 'events.jsonl'), '');

    const result = runCli('run-heartbeat.ts', ['--run-id=run-done-hb', '--agent-id=worker-01']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run_started first');
    expect(readEvents().some((e) => e.event === 'heartbeat' && e.run_id === 'run-done-hb')).toBe(false);
  });
});

// ── run-work-complete invalid finalization state transitions ─────────────────
//
// run-work-complete is only valid when finalization_state is null (first call)
// or 'finalize_rebase_in_progress' (post-rebase call). All other states must
// be rejected to protect the coordinator finalization protocol.

describe('run-work-complete invalid finalization state transitions', () => {
  it('rejects when finalization_state is awaiting_finalize', () => {
    seedInProgressRun({ runId: 'run-wc-awaiting', finalizationState: 'awaiting_finalize' });
    markTaskDone();

    const result = runCli('run-work-complete.ts', ['--run-id=run-wc-awaiting', '--agent-id=worker-01']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('awaiting_finalize');
  });

  it('rejects when finalization_state is finalize_rebase_requested', () => {
    seedInProgressRun({ runId: 'run-wc-requested', finalizationState: 'finalize_rebase_requested' });
    markTaskDone();

    const result = runCli('run-work-complete.ts', ['--run-id=run-wc-requested', '--agent-id=worker-01']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('finalize_rebase_requested');
  });

  it('rejects when finalization_state is ready_to_merge', () => {
    seedInProgressRun({ runId: 'run-wc-rtm', finalizationState: 'ready_to_merge' });
    markTaskDone();

    const result = runCli('run-work-complete.ts', ['--run-id=run-wc-rtm', '--agent-id=worker-01']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ready_to_merge');
  });

  it('rejects when finalization_state is blocked_finalize', () => {
    seedInProgressRun({ runId: 'run-wc-blocked', finalizationState: 'blocked_finalize' });
    markTaskDone();

    const result = runCli('run-work-complete.ts', ['--run-id=run-wc-blocked', '--agent-id=worker-01']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('blocked_finalize');
  });

  it('accepts and emits work_complete when finalization_state is null (first call)', () => {
    seedInProgressRun({ runId: 'run-wc-null', finalizationState: null });
    markTaskDone();

    const result = runCli('run-work-complete.ts', ['--run-id=run-wc-null', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('work_complete');
    expect(readEvents().some((e) =>
      e.event === 'work_complete' && e.run_id === 'run-wc-null')).toBe(true);
  });

  it('accepts and emits ready_to_merge when finalization_state is finalize_rebase_in_progress', () => {
    seedInProgressRun({ runId: 'run-wc-rebase-ip', finalizationState: 'finalize_rebase_in_progress' });
    markTaskDone();

    const result = runCli('run-work-complete.ts', ['--run-id=run-wc-rebase-ip', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ready_to_merge');
    expect(readEvents().some((e) =>
      e.event === 'ready_to_merge' && e.run_id === 'run-wc-rebase-ip')).toBe(true);
  });
});

// ── Idempotent retry behavior ─────────────────────────────────────────────────
//
// Workers may retry lifecycle calls after transient failures. These tests
// document the current retry-safe behavior so regressions are caught.

describe('run-finish idempotent retry', () => {
  it('exits 0 on the second call without crashing (duplicate event is acceptable)', () => {
    seedInProgressRun({ runId: 'run-fin-retry', agentId: 'worker-01' });

    const first = runCli('run-finish.ts', ['--run-id=run-fin-retry', '--agent-id=worker-01']);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('run_finished');

    // Second call on the same in_progress claim: must not crash.
    const second = runCli('run-finish.ts', ['--run-id=run-fin-retry', '--agent-id=worker-01']);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('run_finished');
  });
});

describe('run-fail idempotent retry', () => {
  it('exits 0 on the second call without crashing', () => {
    seedInProgressRun({ runId: 'run-fail-retry', agentId: 'worker-01' });

    const first = runCli('run-fail.ts', ['--run-id=run-fail-retry', '--agent-id=worker-01', '--reason=transient error']);
    expect(first.status).toBe(0);

    // Second call: must not crash.
    const second = runCli('run-fail.ts', ['--run-id=run-fail-retry', '--agent-id=worker-01', '--reason=transient error']);
    expect(second.status).toBe(0);
  });
});

// ── run-fail --code flag ──────────────────────────────────────────────────────
//
// run-fail accepts an optional --code flag that is recorded in the event payload.
// Infrastructure failure codes (ERR_DISPATCH_FAILURE etc.) bypass the attempt
// counter in the coordinator. Verify the CLI surfaces them correctly.

describe('run-fail --code flag', () => {
  it('records a custom failure code in the event payload', () => {
    seedInProgressRun({ runId: 'run-fail-code', agentId: 'worker-01' });

    const result = runCli('run-fail.ts', [
      '--run-id=run-fail-code',
      '--agent-id=worker-01',
      '--reason=dispatch failed',
      '--code=ERR_DISPATCH_FAILURE',
    ]);

    expect(result.status).toBe(0);
    const events = readEvents();
    const failEvent = events.find((e) => e.event === 'run_failed' && e.run_id === 'run-fail-code');
    expect(failEvent).toBeTruthy();
    expect((failEvent!.payload as Record<string, unknown>).code).toBe('ERR_DISPATCH_FAILURE');
    expect((failEvent!.payload as Record<string, unknown>).reason).toBe('dispatch failed');
  });

  it('defaults to ERR_WORKER_REPORTED_FAILURE when --code is omitted', () => {
    seedInProgressRun({ runId: 'run-fail-nocode', agentId: 'worker-01' });

    const result = runCli('run-fail.ts', [
      '--run-id=run-fail-nocode',
      '--agent-id=worker-01',
      '--reason=unknown error',
    ]);

    expect(result.status).toBe(0);
    const failEvent = readEvents().find((e) => e.event === 'run_failed' && e.run_id === 'run-fail-nocode');
    expect((failEvent!.payload as Record<string, unknown>).code).toBe('ERR_WORKER_REPORTED_FAILURE');
  });
});
