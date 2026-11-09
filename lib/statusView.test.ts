import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';
import { ATTENTION_PRECEDENCE, buildAgentStatus, buildStatus, deriveAttention, formatAgentStatus, formatStatus, withProjectSelection } from './statusView.ts';
import { STALLED_RUN_IDLE_SECONDS } from './constants.ts';
import { setRunInputState } from './claimManager.ts';
import { formatProjectIdentity } from './projectHealth.ts';
import { writeRunActivity } from './runActivityStore.ts';
import * as eventLog from './eventLog.ts';
import { listWaitingInput } from './waitingInput.ts';
import type { Agent, Task, Claim } from '../types/index.ts';

type StatusResult = {
  worker_capacity: { configured_slots: number; available_slots: number; used_slots: number; warming_slots: number; dispatch_ready_count: number; waiting_for_capacity: number; slots: Array<{ agent_id: string; role?: string }> };
  scouts: Array<Record<string, unknown>>;
  scout_capacity?: unknown;
  tasks: { total: number; counts: Record<string, number> };
  claims: { total: number; active: Array<Record<string, unknown>>; in_progress: number; awaiting_run_started: number; stalled: number };
  master: { agent_id: string } | null;
  recentEvents: Array<{ seq: number }>;
  finalization: { total: number; blocked_finalize: number; blocked_preserved: Array<{ run_branch: string; run_worktree_path: string }> };
  failures: { startup: Array<{ reason: string }>; lifecycle: Array<{ event: string; reason: string }> };
  stalled_runs: number;
  active_tasks: Array<Record<string, unknown>>;
  task_counts: Record<string, number>;
  agents: Array<Record<string, unknown>>;
  agent: { agent_id: string } | null;
  assigned_tasks: Array<Record<string, unknown>>;
  queued_tasks: Array<Record<string, unknown>>;
};

// root = test-controlled repo root; dir = root/.orc-state (the stateDir).
let root: string;
let dir: string;
// Registry settings buildStatus reads (injected: tests have no registry).
let settings: Record<string, unknown>;
beforeEach(() => {
  settings = {};
  root = createTempStateDir('orch-status-test-');
  dir = join(root, '.orc-state');
  mkdirSync(dir);
});
afterEach(() => { cleanupTempStateDir(root); });

function writeState({ agents = [] as Agent[], claims = [] as Claim[], tasks = [] as Task[], runWorktrees = [] as unknown[] } = {}) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  seedProjectTasks(dir, tasks as unknown as Array<{ ref: string }>, claims);
  writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({
    version: '1',
    runs: runWorktrees,
  }));
}

function writeConfig(config: Record<string, unknown>) {
  settings = config;
}

function writeEvents(events: Record<string, unknown>[]) {
  const normalized = events.map((e, idx) => ({
    seq: idx + 1,
    ts: '2026-01-01T00:00:00Z',
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    ...e,
  }));
  writeFileSync(join(dir, 'events.jsonl'), normalized.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

describe('buildStatus', () => {
  it('returns zeros/empty for empty base state', () => {
    writeState();
    writeEvents([]);
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.worker_capacity.configured_slots).toBe(0);
    expect(s.tasks.total).toBe(0);
    expect(s.claims.total).toBe(0);
  });

  it('separates the master from live worker capacity', () => {
    writeState({
      agents: [
        { agent_id: 'master', provider: 'claude', role: 'master', status: 'running' } as Agent,
        { agent_id: 'amber-anchor', provider: 'codex', role: 'worker', status: 'idle' } as Agent,
      ],
    });
    writeConfig({ worker_pool: { max_workers: 2, provider: 'codex' } });
    writeEvents([]);
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.master?.agent_id).toBe('master');
    expect(s.worker_capacity.configured_slots).toBe(2);
    // One live worker consumes a slot; available = max - live
    expect(s.worker_capacity.available_slots).toBe(1);
    // Only the registered worker appears — no synthetic idle slots
    expect(s.worker_capacity.slots.map((slot) => slot.agent_id)).toEqual(['amber-anchor']);
  });

  it('lists scouts by id and state, not as capacity', () => {
    writeState({
      agents: [
        { agent_id: 'master', provider: 'claude', role: 'master', status: 'running' } as Agent,
        { agent_id: 'amber-anchor', provider: 'codex', role: 'worker', status: 'idle' } as Agent,
        { agent_id: 'scout-1', provider: 'codex', role: 'scout', status: 'running', session_handle: 'tmux:scout-1' } as Agent,
        { agent_id: 'scout-2', provider: 'claude', role: 'scout', status: 'idle', registered_at: '2026-01-01T00:00:00Z' } as Agent,
      ],
    });
    writeConfig({ worker_pool: { max_workers: 1, provider: 'codex' } });
    writeEvents([]);

    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.worker_capacity.slots.map((slot) => slot.agent_id)).toEqual(['amber-anchor']);
    expect(s.scout_capacity).toBeUndefined();
    expect(s.scouts).toEqual([
      { agent_id: 'scout-1', provider: 'codex', model: null, status: 'running', session_handle: 'tmux:scout-1', launched_at: null },
      { agent_id: 'scout-2', provider: 'claude', model: null, status: 'idle', session_handle: null, launched_at: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('counts tasks by status', () => {
    writeState({
      tasks: [
        { ref: 'a/1', title: 'a/1', status: 'todo' },
        { ref: 'a/2', title: 'a/2', status: 'todo' },
        { ref: 'a/3', title: 'a/3', status: 'done' },
        { ref: 'a/4', title: 'a/4', status: 'in_progress' },
      ],
    });
    writeEvents([]);
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.tasks.total).toBe(4);
    expect(s.tasks.counts.todo).toBe(2);
    expect(s.tasks.counts.done).toBe(1);
    expect(s.tasks.counts.in_progress).toBe(1);
  });

  it('lists only active (non-terminal) claims', () => {
    writeState({
      agents: [{ agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running' } as Agent],
      claims: [
        {
          run_id: 'run-1',
          task_ref: 'a/1',
          agent_id: 'orc-1',
          state: 'in_progress',
          claimed_at: '2026-01-01T00:00:00Z',
          lease_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        } as Claim,
        {
          run_id: 'run-2',
          task_ref: 'a/2',
          agent_id: 'orc-1',
          state: 'done',
          claimed_at: '2026-01-01T00:00:00Z',
        } as Claim,
      ],
    });
    writeConfig({ worker_pool: { max_workers: 1, provider: 'codex' } });
    writeEvents([]);
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.claims.total).toBe(1);
    expect(s.claims.active[0].run_id).toBe('run-1');
    expect(s.claims.in_progress).toBe(1);
    expect(s.claims.awaiting_run_started).toBe(0);
    expect(s.worker_capacity.used_slots).toBe(1);
  });

  it('returns last 20 events', () => {
    writeState();
    const events = Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, event: 'heartbeat', agent_id: 'agent-01' }));
    writeEvents(events);
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.recentEvents).toHaveLength(20);
    expect(s.recentEvents[0].seq).toBe(6);
  });

  it('computes active run age/idle/activity fields', () => {
    const now = new Date();
    const claimedAt = new Date(now.getTime() - 60_000).toISOString();
    writeState({
      claims: [{
        run_id: 'run-1',
        task_ref: 'a/1',
        agent_id: 'agent-01',
        state: 'in_progress',
        claimed_at: claimedAt,
        lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
      }],
    });
    writeEvents([
      {
        seq: 1,
        run_id: 'run-1',
        task_ref: 'a/1',
        agent_id: 'agent-01',
        actor_type: 'agent',
        event: 'phase_started',
        ts: new Date(now.getTime() - 30_000).toISOString(),
      },
    ]);
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.claims.active[0].age_seconds).not.toBeNull();
    expect(s.claims.active[0].idle_seconds).not.toBeNull();
    expect(s.claims.active[0].last_activity_event).toBe('phase_started');
  });

  it('anchors claimed run age on task_envelope_sent_at when present', () => {
    const now = new Date();
    writeState({
      claims: [{
        run_id: 'run-claimed',
        task_ref: 'a/1',
        agent_id: 'agent-01',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        task_envelope_sent_at: new Date(now.getTime() - 20_000).toISOString(),
        lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
      }],
    });
    writeEvents([]);
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect((s.claims.active[0].age_seconds as number)).toBeLessThan(60);
    expect((s.claims.active[0].idle_seconds as number)).toBeLessThan(60);
  });

  it('does not mark pre-delivery claimed runs as aged or stalled', () => {
    writeState({
      claims: [{
        run_id: 'run-awaiting-delivery',
        task_ref: 'a/1',
        agent_id: 'agent-01',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        task_envelope_sent_at: null,
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }],
    });
    writeEvents([]);
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.claims.active[0].age_seconds).toBeNull();
    expect(s.claims.active[0].idle_seconds).toBeNull();
    expect(s.claims.active[0].stalled).toBe(false);
    expect(s.claims.stalled).toBe(0);
  });

  it('does not mark awaiting-input runs as stalled even when idle', () => {
    const now = new Date();
    writeState({
      claims: [{
        run_id: 'run-awaiting-input',
        task_ref: 'a/1',
        agent_id: 'agent-01',
        state: 'claimed',
        claimed_at: new Date(now.getTime() - 20 * 60_000).toISOString(),
        task_envelope_sent_at: new Date(now.getTime() - 19 * 60_000).toISOString(),
        lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
        input_state: 'awaiting_input',
        input_requested_at: new Date(now.getTime() - 18 * 60_000).toISOString(),
      }],
    });
    writeEvents([]);

    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.claims.active[0].idle_seconds).toBeGreaterThan(0);
    expect(s.claims.active[0].stalled).toBe(false);
    expect(s.claims.stalled).toBe(0);
  });

  it('computes activity_seconds from last non-heartbeat event, excluding heartbeats', () => {
    const now = new Date();
    writeState({
      claims: [{
        run_id: 'run-act',
        task_ref: 'a/1',
        agent_id: 'agent-01',
        state: 'in_progress',
        claimed_at: new Date(now.getTime() - 120_000).toISOString(),
        last_heartbeat_at: new Date(now.getTime() - 10_000).toISOString(),
        lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
      }],
    });
    writeEvents([
      { run_id: 'run-act', task_ref: 'a/1', agent_id: 'agent-01', actor_type: 'agent', event: 'phase_started', ts: new Date(now.getTime() - 60_000).toISOString() },
      { run_id: 'run-act', task_ref: 'a/1', agent_id: 'agent-01', actor_type: 'agent', event: 'heartbeat', ts: new Date(now.getTime() - 10_000).toISOString() },
    ]);
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    const claim = s.claims.active[0];
    // activity_seconds reflects last non-heartbeat event (~60s ago), not the heartbeat
    expect((claim.activity_seconds as number)).toBeGreaterThanOrEqual(55);
    expect((claim.activity_seconds as number)).toBeLessThan(90);
    // heartbeat_seconds reflects last_heartbeat_at (~10s ago)
    expect((claim.heartbeat_seconds as number)).toBeGreaterThanOrEqual(5);
    expect((claim.heartbeat_seconds as number)).toBeLessThan(30);
  });

  it('returns null activity_seconds when no non-heartbeat event exists', () => {
    const now = new Date();
    writeState({
      claims: [{
        run_id: 'run-hb-only',
        task_ref: 'a/1',
        agent_id: 'agent-01',
        state: 'in_progress',
        claimed_at: new Date(now.getTime() - 30_000).toISOString(),
        last_heartbeat_at: new Date(now.getTime() - 5_000).toISOString(),
        lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
      }],
    });
    writeEvents([
      { run_id: 'run-hb-only', task_ref: 'a/1', agent_id: 'agent-01', actor_type: 'agent', event: 'heartbeat', ts: new Date(now.getTime() - 5_000).toISOString() },
    ]);
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    const claim = s.claims.active[0];
    // No non-heartbeat activity → activity_seconds is null
    expect(claim.activity_seconds).toBeNull();
    // heartbeat_seconds from last_heartbeat_at
    expect((claim.heartbeat_seconds as number)).toBeGreaterThanOrEqual(0);
    expect((claim.heartbeat_seconds as number)).toBeLessThan(30);
  });

  it('includes current_phase from phase_started events', () => {
    const now = new Date();
    writeState({
      claims: [{
        run_id: 'run-phase',
        task_ref: 'a/1',
        agent_id: 'agent-01',
        state: 'in_progress',
        claimed_at: new Date(now.getTime() - 60_000).toISOString(),
        lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
      }],
    });
    writeEvents([
      { event_id: 'evt-p1', run_id: 'run-phase', task_ref: 'a/1', agent_id: 'agent-01', actor_type: 'agent', event: 'phase_started', phase: 'explore', ts: new Date(now.getTime() - 50_000).toISOString() },
      { event_id: 'evt-p2', run_id: 'run-phase', task_ref: 'a/1', agent_id: 'agent-01', actor_type: 'agent', event: 'phase_started', phase: 'implement', ts: new Date(now.getTime() - 30_000).toISOString() },
    ]);
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.claims.active[0].current_phase).toBe('implement');
  });

  it('returns null current_phase when no phase events exist', () => {
    const now = new Date();
    writeState({
      claims: [{
        run_id: 'run-nophase',
        task_ref: 'a/1',
        agent_id: 'agent-01',
        state: 'in_progress',
        claimed_at: new Date(now.getTime() - 60_000).toISOString(),
        lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
      }],
    });
    writeEvents([]);
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.claims.active[0].current_phase).toBeNull();
  });

  it('counts dispatch-ready work waiting for capacity', () => {
    writeState({
      agents: [{ agent_id: 'amber-anchor', provider: 'codex', role: 'worker', status: 'running', session_handle: 'tmux:amber-anchor' } as Agent],
      tasks: [
        { ref: 'orch/task-1', title: 'Task 1', status: 'todo' },
        { ref: 'orch/task-2', title: 'Task 2', status: 'todo', depends_on: ['orch/task-3'] },
        { ref: 'orch/task-3', title: 'Task 3', status: 'done' },
      ],
    });
    writeConfig({ worker_pool: { max_workers: 1, provider: 'codex' } });
    writeEvents([]);

    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.worker_capacity.dispatch_ready_count).toBe(2);
    // One live worker consumes the only slot; no additional capacity to spawn workers.
    expect(s.worker_capacity.available_slots).toBe(0);
    expect(s.worker_capacity.waiting_for_capacity).toBe(2);
  });

  it('live workers without active claims still consume capacity slots', () => {
    writeState({
      agents: [{ agent_id: 'amber-anchor', provider: 'codex', role: 'worker', status: 'running', session_handle: 'tmux:amber-anchor' } as Agent],
    });
    writeConfig({ worker_pool: { max_workers: 2, provider: 'codex' } });
    writeEvents([]);

    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    // One registered worker consumes 1 of 2 slots; 1 remains available.
    expect(s.worker_capacity.available_slots).toBe(1);
    expect(s.worker_capacity.warming_slots).toBe(0);
  });

  it('surfaces stalled runs and recent failures', () => {
    const now = new Date();
    writeState({
      agents: [{ agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running' } as Agent],
      claims: [{
        run_id: 'run-1',
        task_ref: 'orch/task-1',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date(now.getTime() - 20 * 60_000).toISOString(),
        started_at: new Date(now.getTime() - 20 * 60_000).toISOString(),
        lease_expires_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
      }],
      tasks: [{ ref: 'orch/task-1', title: 'Task 1', status: 'in_progress' }],
    });
    writeConfig({ worker_pool: { max_workers: 1, provider: 'codex' } });
    writeEvents([
      {
        run_id: 'run-1',
        task_ref: 'orch/task-1',
        agent_id: 'orc-1',
        event: 'session_start_failed',
        payload: { reason: 'binary missing' },
        ts: new Date(now.getTime() - 15 * 60_000).toISOString(),
      },
      {
        run_id: 'run-1',
        task_ref: 'orch/task-1',
        agent_id: 'orc-1',
        event: 'blocked',
        payload: { reason: 'awaiting input' },
        ts: new Date(now.getTime() - 12 * 60_000).toISOString(),
      },
    ]);

    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.claims.stalled).toBe(1);
    expect(s.failures.startup[0].reason).toBe('binary missing');
    expect(s.failures.lifecycle[0].event).toBe('blocked');
  });

  it('scopes recent failures to the latest session_started boundary', () => {
    const now = new Date();
    writeState({
      tasks: [{ ref: 'orch/task-1', title: 'Task 1', status: 'todo' }],
    });
    writeEvents([
      {
        event: 'run_failed',
        run_id: 'run-old',
        task_ref: 'orch/task-1',
        agent_id: 'orc-1',
        actor_type: 'agent',
        actor_id: 'orc-1',
        payload: { reason: 'yesterday failure', policy: 'requeue' },
        ts: new Date(now.getTime() - 60_000).toISOString(),
      },
      {
        event: 'session_started',
        payload: {
          session_id: 'session-1',
          reset_tasks: 0,
          reset_claims: 0,
          reset_agents: 0,
        },
        ts: new Date(now.getTime() - 30_000).toISOString(),
      },
      {
        event: 'blocked',
        run_id: 'run-new',
        task_ref: 'orch/task-1',
        agent_id: 'orc-1',
        actor_type: 'agent',
        actor_id: 'orc-1',
        payload: { reason: 'current failure' },
        ts: new Date(now.getTime() - 10_000).toISOString(),
      },
    ]);

    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.failures.lifecycle).toHaveLength(1);
    expect(s.failures.lifecycle[0].reason).toBe('current failure');
  });

  it('surfaces finalization counts and preserved blocked work metadata', () => {
    writeState({
      claims: [{
        run_id: 'run-finalize-1',
        task_ref: 'orch/task-151',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        finalization_state: 'blocked_finalize',
        finalization_retry_count: 2,
        finalization_blocked_reason: 'needs manual resolution',
      }],
      runWorktrees: [{
        run_id: 'run-finalize-1',
        task_ref: 'orch/task-151',
        agent_id: 'orc-1',
        branch: 'task/run-finalize-1',
        worktree_path: '/tmp/orc-worktrees/run-finalize-1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }],
    });
    writeEvents([]);

    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.finalization.total).toBe(1);
    expect(s.finalization.blocked_finalize).toBe(1);
    expect(s.finalization.blocked_preserved[0].run_branch).toBe('task/run-finalize-1');
    expect(s.finalization.blocked_preserved[0].run_worktree_path).toBe('/tmp/orc-worktrees/run-finalize-1');
  });
});

describe('current_activity', () => {
  function seedActiveRun() {
    writeState({
      agents: [{ agent_id: 'orc-1', provider: 'claude', role: 'worker', status: 'running', session_handle: 'tmux:1' } as Agent],
      claims: [{
        run_id: 'run-act-1',
        task_ref: 'orch/task-1',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      } as Claim],
      tasks: [{ ref: 'orch/task-1', title: 'Task 1', status: 'in_progress', owner: 'orc-1', planning_state: 'ready_for_dispatch' } as Task],
    });
    writeEvents([]);
  }

  it('is null on an active run without an activity snapshot', () => {
    seedActiveRun();
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    expect(s.claims.active[0].current_activity).toBeNull();
    expect(formatStatus(s as unknown as Record<string, unknown>)).not.toContain('└');
  });

  it('carries the ranked activity and shows it in text-mode status', () => {
    seedActiveRun();
    const ts = new Date(Date.now() - 12_000).toISOString();
    writeRunActivity(dir, {
      'run-act-1': {
        run_id: 'run-act-1', agent_id: 'orc-1', label: 'Fixing findings from the critic', source: 'note', label_ts: ts,
        last_tool: 'Edit', last_tool_brief: 'lib/x.ts', last_tool_ts: ts,
      },
    });
    const s = buildStatus(dir, { settings });
    const claim = (s as unknown as StatusResult).claims.active[0];
    expect(claim.current_activity).toEqual({ text: 'Fixing findings from the critic', source: 'note', ts });
    expect(formatStatus(s)).toMatch(/\n {4}└ Fixing findings from the critic {3}\(1\ds ago\)/);
    expect(formatAgentStatus(buildAgentStatus(dir, 'orc-1'), 'orc-1')).toContain('└ Fixing findings from the critic');
  });

  it('measures idle time from hook activity too, as the coordinator does, and never stalls a running tool call', () => {
    const old = new Date(Date.now() - 40 * 60_000).toISOString();
    writeState({
      agents: [{ agent_id: 'orc-1', provider: 'claude', role: 'worker', status: 'running', session_handle: 'tmux:1' } as Agent],
      claims: ['run-hook', 'run-tool'].map((run_id, index) => ({
        run_id, task_ref: `orch/task-${index + 1}`, agent_id: 'orc-1', state: 'in_progress',
        claimed_at: old, started_at: old, last_heartbeat_at: old,
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      } as Claim)),
      tasks: [1, 2].map((n) => ({ ref: `orch/task-${n}`, title: `Task ${n}`, status: 'in_progress', owner: 'orc-1', planning_state: 'ready_for_dispatch' } as Task)),
    });
    writeEvents([]);
    const recent = new Date(Date.now() - 30_000).toISOString();
    const started = new Date(Date.now() - 20 * 60_000).toISOString();
    writeRunActivity(dir, {
      'run-hook': {
        run_id: 'run-hook', agent_id: 'orc-1', label: 'Edit: a.ts', source: 'tool', label_ts: recent,
        last_tool: 'Edit', last_tool_brief: 'a.ts', last_tool_ts: recent,
      },
      'run-tool': {
        run_id: 'run-tool', agent_id: 'orc-1', label: null, source: null, label_ts: null,
        last_tool: null, last_tool_brief: null, last_tool_ts: null, open_tools: { toolu_1: started },
      },
    });
    const s = buildStatus(dir, { settings }) as unknown as StatusResult;
    const byRun = new Map(s.claims.active.map((claim) => [claim.run_id, claim]));
    expect(byRun.get('run-hook')?.idle_seconds).toBeLessThan(60);
    expect(byRun.get('run-hook')?.stalled).toBe(false);
    // Twenty minutes into one tool call: idle by the clock, but not stalled.
    expect(byRun.get('run-tool')?.idle_seconds).toBeGreaterThanOrEqual(20 * 60);
    expect(byRun.get('run-tool')?.stalled).toBe(false);
    expect(s.claims.stalled).toBe(0);
  });
});

describe('formatStatus', () => {
  it('prints a Waiting for input section near the top only when a run is waiting', () => {
    writeState({
      claims: [{
        run_id: 'run-w', task_ref: 'feat/ask', agent_id: 'agent-07', state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00Z', lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        input_state: 'awaiting_input',
      } as Claim],
    });
    writeEvents([{
      event: 'input_requested', run_id: 'run-w', task_ref: 'feat/ask', agent_id: 'agent-07', actor_type: 'agent', actor_id: 'agent-07',
      payload: { question: `Which schema?\nOption A or B ${'x'.repeat(100)}` }, ts: new Date(Date.now() - 42_000).toISOString(),
    }]);
    const status = buildStatus(dir, { settings });
    const output = formatStatus(status);
    expect(output).toMatch(/Waiting for input \(1\):\n {2}agent-07\s+feat\/ask waiting=4\ds\n {4}question: Which schema\? Option A or B x+…\n {2}answer: orc run-input-respond/);
    expect(output.indexOf('Waiting for input')).toBeLessThan(output.indexOf('Master:'));

    expect(formatStatus({ ...status, waiting_input: [] })).not.toContain('Waiting for input');
  });

  it('produces a non-empty string', () => {
    writeState();
    writeEvents([]);
    const output = formatStatus(buildStatus(dir, { settings }));
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('includes "Orchestrator Status" header', () => {
    writeState();
    writeEvents([]);
    expect(formatStatus(buildStatus(dir, { settings }))).toContain('Orchestrator Status');
  });

  it('renders master, worker capacity, and active runs sections', () => {
    writeState({
      agents: [{ agent_id: 'master', provider: 'claude', role: 'master', status: 'running' } as Agent],
      claims: [{
        run_id: 'run-1',
        task_ref: 'orch/task-1',
        agent_id: 'orc-1',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
      } as Claim],
      tasks: [{ ref: 'orch/task-1', title: 'Task 1', status: 'in_progress' }],
    });
    writeConfig({ worker_pool: { max_workers: 1, provider: 'codex' } });
    writeEvents([]);
    const output = formatStatus(buildStatus(dir, { settings }));
    expect(output).toContain('Master:');
    expect(output).toContain('Worker Capacity:');
    expect(output).toContain('Active Runs (1):');
    expect(output).toContain('orc-1');
  });

  it('renders queued task refs in the capacity section', () => {
    writeState({
      tasks: [{ ref: 'orch/task-queued', title: 'Queued', status: 'todo' }],
    });
    writeConfig({ worker_pool: { max_workers: 0, provider: 'codex' } });
    writeEvents([]);

    const output = formatStatus(buildStatus(dir, { settings }));
    expect(output).toContain('queue:               orch/task-queued');
  });

  it('renders finalization state and preserved blocked work clearly', () => {
    writeState({
      claims: [{
        run_id: 'run-finalize-2',
        task_ref: 'orch/task-152',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
        finalization_state: 'blocked_finalize',
        finalization_retry_count: 2,
        finalization_blocked_reason: 'cleanup pending',
      }],
      runWorktrees: [{
        run_id: 'run-finalize-2',
        task_ref: 'orch/task-152',
        agent_id: 'orc-1',
        branch: 'task/run-finalize-2',
        worktree_path: '/tmp/orc-worktrees/run-finalize-2',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }],
    });
    writeEvents([]);

    const output = formatStatus(buildStatus(dir, { settings }));
    expect(output).toContain('Finalization (1):');
    expect(output).toContain('blocked_preserved:        1');
    expect(output).toContain('preserved_work');
    expect(output).toContain('task/run-finalize-2');
    expect(output).toContain('/tmp/orc-worktrees/run-finalize-2');
  });

  it('shows live worker with two-word id in capacity section, no phantom orc-N placeholders', () => {
    writeState({
      agents: [
        { agent_id: 'master', provider: 'claude', role: 'master', status: 'running' } as Agent,
        { agent_id: 'amber-anchor', provider: 'claude', role: 'worker', status: 'running', session_handle: 'tmux:amber-anchor' } as Agent,
      ],
    });
    writeConfig({ worker_pool: { max_workers: 3, provider: 'claude' } });
    writeEvents([]);
    const output = formatStatus(buildStatus(dir, { settings }));
    // Live worker shown
    expect(output).toContain('amber-anchor');
    // Capacity shown separately from live worker list
    expect(output).toContain('configured_slots:    3');
    // used_slots reflects active claims (0 here), available_slots reflects remaining concurrency capacity
    expect(output).toContain('used_slots:          0');
    expect(output).toContain('available_slots:     2');
    // No synthetic orc-N placeholders for unregistered slots
    expect(output).not.toContain('orc-2');
    expect(output).not.toContain('orc-3');
  });

  it('renders scouts as their own list, outside worker capacity', () => {
    writeState({
      agents: [
        { agent_id: 'master', provider: 'claude', role: 'master', status: 'running' } as Agent,
        { agent_id: 'scout-1', provider: 'codex', role: 'scout', status: 'running', session_handle: 'tmux:scout-1' } as Agent,
        { agent_id: 'scout-2', provider: 'claude', role: 'scout', status: 'offline' } as Agent,
      ],
    });
    writeEvents([]);

    const output = formatStatus(buildStatus(dir, { settings }));
    expect(output).toContain('slots: (none spawned)');
    expect(output).toContain('Scouts (2):');
    expect(output).toMatch(/scout-1\s+running\s+attached/);
    expect(output).toMatch(/scout-2\s+offline\s+detached/);
    expect(output).not.toContain('investigating');
  });
});

describe('buildAgentStatus', () => {
  it('returns agent-specific active claims and queued owned tasks', () => {
    writeState({
      agents: [{ agent_id: 'agent-01', provider: 'claude', role: 'worker', status: 'running' } as Agent],
      claims: [{
        run_id: 'run-1',
        task_ref: 'orch/task-1',
        agent_id: 'agent-01',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      } as Claim],
      tasks: [
        { ref: 'orch/task-1', title: 'Task 1', status: 'claimed', owner: 'agent-01', planning_state: 'ready_for_dispatch' } as Task,
        { ref: 'orch/task-2', title: 'Task 2', status: 'todo', owner: 'agent-01', planning_state: 'ready_for_dispatch' } as Task,
        { ref: 'orch/task-3', title: 'Task 3', status: 'todo', owner: 'agent-02', planning_state: 'ready_for_dispatch' } as Task,
      ],
    });
    writeEvents([]);

    const status = buildAgentStatus(dir, 'agent-01') as unknown as StatusResult;
    expect(status.agent?.agent_id).toBe('agent-01');
    expect(status.assigned_tasks).toHaveLength(1);
    expect(status.assigned_tasks[0].task_ref).toBe('orch/task-1');
    expect(status.queued_tasks).toEqual([
      {
        ref: 'orch/task-2',
        title: 'Task 2',
        status: 'todo',
        feature_ref: 'orch',
        task_type: 'implementation',
        planning_state: 'ready_for_dispatch',
      },
    ]);
  });
});

describe('buildStatus event window', () => {
  const activeRun = (): Claim => ({
    run_id: 'run-live', task_ref: 'orch/task-1', agent_id: 'orc-1', state: 'in_progress',
    claimed_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:00:01Z',
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
  } as Claim);
  const sessions = (count: number) => Array.from({ length: count }, (_, n) => [
    { event: 'run_failed', run_id: `run-old-${n}`, task_ref: 'orch/task-1', agent_id: 'orc-1', actor_type: 'agent', actor_id: 'orc-1', payload: { reason: `failure ${n}` } },
    { event: 'session_started', payload: { session_id: `s${n}`, reset_tasks: 0, reset_claims: 0, reset_agents: 0 } },
  ]).flat();

  it('reads only events after the latest session boundary, plus earlier history of active runs', () => {
    writeState({
      agents: [{ agent_id: 'orc-1', provider: 'claude', role: 'worker', status: 'running', session_handle: 'tmux:1' } as Agent],
      claims: [activeRun()],
      tasks: [{ ref: 'orch/task-1', title: 'Task 1', status: 'in_progress', owner: 'orc-1', planning_state: 'ready_for_dispatch' } as Task],
    });
    writeEvents([
      { event: 'phase_started', run_id: 'run-live', task_ref: 'orch/task-1', agent_id: 'orc-1', actor_type: 'agent', actor_id: 'orc-1', payload: { phase: 'implement' } },
      ...sessions(3),
      { event: 'heartbeat', run_id: 'run-live', task_ref: 'orch/task-1', agent_id: 'orc-1', actor_type: 'agent', actor_id: 'orc-1', payload: {}, ts: '2026-01-01T00:05:00Z' },
    ]);
    const readEvents = vi.spyOn(eventLog, 'readEvents');
    const s = buildStatus(dir, { settings }) as unknown as StatusResult & { cursor: number };
    expect(readEvents).not.toHaveBeenCalled();
    readEvents.mockRestore();
    expect(s.cursor).toBe(8);
    // Failures before the latest boundary are out of scope; the run's pre-boundary phase still shows.
    expect(s.failures.lifecycle).toEqual([]);
    expect(s.claims.active[0]).toMatchObject({ current_phase: 'implement', last_activity_event: 'heartbeat' });
  });

  it('reads the cursor before the state, so an event committed in between is after the cursor', () => {
    writeState();
    writeEvents([{ event: 'heartbeat', agent_id: 'orc-1', payload: {} }]);
    const realCursor = eventLog.readEventCursor;
    const spy = vi.spyOn(eventLog, 'readEventCursor').mockImplementation((stateDir: string) => {
      const cursor = realCursor(stateDir);
      // A concurrent writer commits right after the cursor read, before claims/backlog/agents are read.
      eventLog.appendEvent(join(stateDir, 'events.jsonl'), {
        seq: 2, ts: '2026-01-01T00:00:01Z', event: 'heartbeat', agent_id: 'orc-1', actor_type: 'coordinator', actor_id: 'coordinator', payload: {},
      } as Parameters<typeof eventLog.appendEvent>[1]);
      return cursor;
    });
    const s = buildStatus(dir, { settings }) as unknown as StatusResult & { cursor: number };
    spy.mockRestore();
    expect((s as unknown as { eventReadError: string }).eventReadError).toBe('');
    expect(s.cursor).toBe(1);
    expect(s.recentEvents.map((e) => e.seq)).toEqual([1]);
    expect(eventLog.readEventsSince(join(dir, 'events.jsonl'), s.cursor).map((e) => e.seq)).toEqual([2]);
  });

  it('bounds recentEvents with the events option and rejects out-of-range counts', () => {
    writeState();
    writeEvents(Array.from({ length: 30 }, () => ({ event: 'heartbeat', agent_id: 'orc-1', payload: {} })));
    const count = (events?: number) => (buildStatus(dir, { settings, ...(events === undefined ? {} : { events }) }) as unknown as StatusResult).recentEvents;
    expect(count()).toHaveLength(20);
    expect(count(20).map((e) => e.seq)).toEqual(count().map((e) => e.seq));
    expect(count(0)).toEqual([]);
    expect(count(200)).toHaveLength(30);
    expect(() => count(201)).toThrow(RangeError);
    expect(() => count(-1)).toThrow(RangeError);
  });

  it('lists awaiting_input runs with their latest question and counts them in claims.waiting_input', () => {
    writeState({
      claims: [{
        run_id: 'run-q', task_ref: 'a/1', agent_id: 'agent-01', state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00Z', lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        input_state: 'awaiting_input',
      } as Claim],
    });
    writeEvents([
      ...Array.from({ length: 60 }, (_, n) => ({ event: 'input_requested', run_id: 'run-q', task_ref: 'a/1', agent_id: 'agent-01', actor_type: 'agent', actor_id: 'agent-01', payload: { question: `q${n}` }, ts: new Date(Date.now() - 60_000 + n).toISOString() })),
    ]);
    const s = buildStatus(dir, { settings });
    expect(s.waiting_input).toEqual([expect.objectContaining({ run_id: 'run-q', agent_id: 'agent-01', task_ref: 'a/1', question: 'q59' })]);
    expect(s.claims.waiting_input).toBe(1);
    const direct = listWaitingInput(dir, [{ run_id: 'run-q', task_ref: 'a/1', agent_id: 'agent-01', state: 'in_progress', input_state: 'awaiting_input' } as Claim]);
    expect(direct[0]).toMatchObject({ question: 'q59' });
    expect(direct[0].waiting_seconds).toBeGreaterThanOrEqual(59);
    expect(listWaitingInput(dir, [{ run_id: 'run-x', task_ref: 'a/2', agent_id: 'agent-01', input_state: 'none' } as unknown as Claim])).toEqual([]);
  });

  it('leaves out finished claims that still carry a stale awaiting_input (legacy runs)', () => {
    const claim = (run_id: string, state: Claim['state']) => ({
      run_id, task_ref: 'a/1', agent_id: 'orc-1', state, input_state: 'awaiting_input',
      claimed_at: '2026-03-29T18:00:00Z', lease_expires_at: '2026-03-29T18:30:00Z',
    } as Claim);
    const claims = [claim('run-claimed', 'claimed'), claim('run-live', 'in_progress'), claim('run-failed', 'failed'), claim('run-done', 'done')];
    expect(listWaitingInput(dir, claims).map((row) => row.run_id)).toEqual(['run-claimed', 'run-live']);

    writeState({ claims: [claim('run-failed', 'failed'), claim('run-done', 'done')] });
    writeEvents([]);
    const status = buildStatus(dir, { settings });
    expect(status.waiting_input).toEqual([]);
    expect(status.claims.waiting_input).toBe(0);
  });
});

describe('formatAgentStatus', () => {
  it('prints a compact agent-specific status view', () => {
    const output = formatAgentStatus({
      agent: { agent_id: 'agent-01', provider: 'claude', role: 'worker', status: 'running' },
      assigned_tasks: [{ task_ref: 'orch/task-1', state: 'claimed', run_id: 'run-1' }],
      queued_tasks: [{ ref: 'orch/task-2', status: 'todo', planning_state: 'ready_for_dispatch' }],
    }, 'agent-01');

    expect(output).toContain('Agent Status: agent-01');
    expect(output).toContain('orch/task-1');
    expect(output).toContain('orch/task-2');
  });
});

describe('withProjectSelection', () => {
  const project = { id: 'p1', name: 'one', target_repo_root: '/repo' };
  it('stamps selected_by only for the project this process resolved', () => {
    expect(withProjectSelection({ project }, { id: 'p1', selectedBy: 'cwd' }).project).toEqual({ ...project, selected_by: 'cwd' });
    expect(withProjectSelection({ project }, { id: 'p2', selectedBy: 'cwd' }).project).toEqual(project);
    expect(withProjectSelection({ project }, null).project).toEqual(project);
    expect(withProjectSelection({ project: null }, { id: 'p1', selectedBy: 'env' }).project).toBeNull();
  });

  it('formats the selection in the project line', () => {
    expect(formatProjectIdentity({ ...project, selected_by: 'flag' })).toBe('project: one (p1) → /repo (selected by --project)');
    expect(formatProjectIdentity({ ...project, selected_by: 'selected' })).toBe('project: one (p1) → /repo (selected by orc project select)');
    expect(formatProjectIdentity(project)).toBe('project: one (p1) → /repo');
  });
});

describe('attention', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const runClaim = (over: Partial<Claim> = {}): Claim => ({
    run_id: 'run-a', task_ref: 'orch/task-1', agent_id: 'orc-1', state: 'in_progress',
    claimed_at: ago(10 * 60_000), started_at: ago(10 * 60_000), last_heartbeat_at: ago(30_000),
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(), ...over,
  } as Claim);
  function seed(claim: Claim, events: Record<string, unknown>[] = []) {
    writeState({
      agents: [
        { agent_id: 'orc-1', provider: 'claude', role: 'worker', status: 'running', session_handle: 'tmux:1' } as Agent,
        { agent_id: 'orc-2', provider: 'claude', role: 'worker', status: 'running', session_handle: 'tmux:2' } as Agent,
      ],
      claims: [claim],
      tasks: [{ ref: 'orch/task-1', title: 'Task 1', status: 'in_progress', owner: 'orc-1', planning_state: 'ready_for_dispatch' } as Task],
    });
    writeEvents(events);
  }
  const ev = (event: string, ts: string, payload: Record<string, unknown>, actor = 'agent') => ({
    event, ts, run_id: 'run-a', task_ref: 'orch/task-1', agent_id: 'orc-1',
    actor_type: actor, actor_id: actor === 'agent' ? 'orc-1' : 'coordinator', payload,
  });
  const read = () => {
    const s = buildStatus(dir, { settings });
    const slot = s.worker_capacity.slots.find((entry) => entry.agent_id === 'orc-1');
    expect(slot?.attention).toEqual(s.claims.active[0]?.attention ?? null);
    return { attention: slot?.attention ?? null, idle: s.worker_capacity.slots.find((entry) => entry.agent_id === 'orc-2')?.attention };
  };

  it('is null for an idle healthy agent and for a healthy run', () => {
    seed(runClaim());
    const { attention, idle } = read();
    expect(attention).toBeNull();
    expect(idle).toBeNull();
  });

  it('shows a worker question with its text and request id, and clears once answered', () => {
    const asked = ago(60_000);
    seed(runClaim({ input_state: 'awaiting_input' }), [ev('input_requested', asked, { question: 'Which table?', request_id: 'req-1' })]);
    expect(read().attention).toEqual({ kind: 'question', run_id: 'run-a', since: asked, detail: 'Which table?', request_id: 'req-1' });
    // respond_input clears input_state; the question is gone.
    setRunInputState(dir, 'run-a', 'orc-1', { inputState: null });
    expect(read().attention).toBeNull();
  });

  it('shows a provider permission prompt and clears it once the worker acts after it', () => {
    const asked = ago(60_000);
    const events = [ev('input_requested', asked, { question: 'Allow Bash: rm -rf dist?', reason: 'remediation_policy:permission_prompt' }, 'coordinator')];
    seed(runClaim({ input_state: 'awaiting_input' }), events);
    writeRunActivity(dir, { 'run-a': {
      run_id: 'run-a', agent_id: 'orc-1', label: null, source: null, label_ts: null,
      last_tool: 'Read', last_tool_brief: 'a.ts', last_tool_ts: ago(90_000), open_tools: { toolu_1: ago(70_000) },
    } });
    expect(read().attention).toEqual({ kind: 'permission_prompt', run_id: 'run-a', since: asked, detail: 'Allow Bash: rm -rf dist?', request_id: null });
    writeRunActivity(dir, { 'run-a': {
      run_id: 'run-a', agent_id: 'orc-1', label: null, source: null, label_ts: null,
      last_tool: 'Bash', last_tool_brief: 'rm -rf dist', last_tool_ts: ago(10_000),
    } });
    expect(read().attention).toBeNull();
  });

  it('shows a stalled run from the shared stalled test, since its idle anchor', () => {
    const idleSince = ago(2 * STALLED_RUN_IDLE_SECONDS * 1000);
    seed(runClaim({ claimed_at: idleSince, started_at: idleSince, last_heartbeat_at: idleSince }));
    expect(read().attention).toMatchObject({ kind: 'stalled', since: idleSince, detail: null });
  });

  it('shows no_progress after the coordinator alert until the run progresses again', () => {
    const progressAt = ago(90 * 60_000);
    const alive = ev('heartbeat', ago(30_000), {});
    const alert = ev('worker_needs_attention', ago(20 * 60_000), { reason: 'no_progress', idle_ms: 1000, no_progress_ms: 3_600_000, phase: 'implement', progress_at: progressAt }, 'coordinator');
    seed(runClaim(), [ev('phase_started', progressAt, { phase: 'implement' }), alert, alive]);
    expect(read().attention).toEqual({ kind: 'no_progress', run_id: 'run-a', since: progressAt, detail: 'implement', request_id: null });
    // A git commit the hooks saw clears it.
    writeRunActivity(dir, { 'run-a': {
      run_id: 'run-a', agent_id: 'orc-1', label: null, source: null, label_ts: null,
      last_tool: 'Bash', last_tool_brief: 'git commit -m "feat: x"', last_tool_ts: ago(60_000),
    } });
    expect(read().attention).toBeNull();
    // So does a phase change after the progress point.
    writeRunActivity(dir, {});
    expect(read().attention?.kind).toBe('no_progress');
    eventLog.appendEvent(join(dir, 'events.jsonl'), { seq: 4, phase: 'review', ...ev('phase_started', ago(60_000), { phase: 'review' }) } as Parameters<typeof eventLog.appendEvent>[1]);
    expect(read().attention).toBeNull();
  });

  it('applies the documented precedence when several conditions hold', () => {
    expect(ATTENTION_PRECEDENCE).toEqual(['permission_prompt', 'question', 'stalled', 'no_progress']);
    const runEvents = { inputRequestedBy: 'agent', noProgressAlert: { progress_at: ago(90 * 60_000), phase: 'implement' }, progressAt: ago(90 * 60_000) };
    const waiting = { run_id: 'run-a', agent_id: 'orc-1', task_ref: 'orch/task-1', question: 'q', request_id: 'r', waiting_seconds: 1, input_requested_at: ago(1000) };
    const claim = { run_id: 'run-a', finalization_state: null, stalled: true };
    const base = { claim, waiting, runEvents, hookSnapshot: null, idleAnchor: ago(5000) };
    expect(deriveAttention(base)?.kind).toBe('question');
    expect(deriveAttention({ ...base, runEvents: { ...runEvents, inputRequestedBy: 'coordinator' } })?.kind).toBe('permission_prompt');
    expect(deriveAttention({ ...base, waiting: null })?.kind).toBe('stalled');
    expect(deriveAttention({ ...base, waiting: null, claim: { ...claim, stalled: false } })?.kind).toBe('no_progress');
    // Finalization is not checked for progress, as in the coordinator.
    expect(deriveAttention({ ...base, waiting: null, claim: { ...claim, stalled: false, finalization_state: 'awaiting_finalize' } })).toBeNull();
  });
});
