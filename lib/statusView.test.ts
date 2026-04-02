import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { buildAgentStatus, buildStatus, formatAgentStatus, formatStatus } from './statusView.ts';
import type { Agent, Task, Claim } from '../types/index.ts';

type StatusResult = {
  worker_capacity: { configured_slots: number; available_slots: number; used_slots: number; warming_slots: number; dispatch_ready_count: number; waiting_for_capacity: number; slots: Array<{ agent_id: string; role?: string }> };
  scout_capacity: { total_slots: number; investigating_slots: number; idle_slots: number; warming_slots: number; unavailable_slots: number; slots: Array<{ agent_id: string; slot_state: string }> };
  tasks: { total: number; counts: Record<string, number> };
  claims: { total: number; active: Array<Record<string, unknown>>; in_progress: number; awaiting_run_started: number; stalled: number };
  master: { agent_id: string } | null;
  recentEvents: Array<{ seq: number }>;
  finalization: { total: number; blocked_finalize: number; blocked_preserved: Array<{ run_branch: string; run_worktree_path: string }> };
  failures: { startup: Array<{ reason: string }>; lifecycle: Array<{ event: string; reason: string }> };
  next_task_seq: number;
  stalled_runs: number;
  active_tasks: Array<Record<string, unknown>>;
  task_counts: Record<string, number>;
  agents: Array<Record<string, unknown>>;
  agent: { agent_id: string } | null;
  assigned_tasks: Array<Record<string, unknown>>;
  queued_tasks: Array<Record<string, unknown>>;
};

// root = test-controlled repo root; dir = root/.orc-state (the stateDir).
// This mirrors real layout so config at root/orchestrator.config.json is found.
let root: string;
let dir: string;
beforeEach(() => {
  root = createTempStateDir('orch-status-test-');
  dir = join(root, '.orc-state');
  mkdirSync(dir);
});
afterEach(() => { cleanupTempStateDir(root); });

function writeState({ agents = [] as Agent[], claims = [] as Claim[], tasks = [] as Task[], runWorktrees = [] as unknown[] } = {}) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'orch', title: 'Orch', tasks }],
  }));
  writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({
    version: '1',
    runs: runWorktrees,
  }));
}

function writeConfig(config: unknown) {
  writeFileSync(join(root, 'orchestrator.config.json'), JSON.stringify(config));
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
    const s = buildStatus(dir) as unknown as StatusResult;
    expect(s.worker_capacity.configured_slots).toBe(0);
    expect(s.tasks.total).toBe(0);
    expect(s.claims.total).toBe(0);
  });

  it('separates the master from managed worker capacity', () => {
    writeState({
      agents: [
        { agent_id: 'master', provider: 'claude', role: 'master', status: 'running' } as Agent,
        { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'idle' } as Agent,
      ],
    });
    writeConfig({ worker_pool: { max_workers: 2, provider: 'codex' } });
    writeEvents([]);
    const s = buildStatus(dir) as unknown as StatusResult;
    expect(s.master?.agent_id).toBe('master');
    expect(s.worker_capacity.configured_slots).toBe(2);
    expect(s.worker_capacity.available_slots).toBe(2);
    expect(s.worker_capacity.slots.map((slot) => slot.agent_id)).toEqual(['orc-1', 'orc-2']);
  });

  it('surfaces scouts in a separate scout capacity block', () => {
    writeState({
      agents: [
        { agent_id: 'master', provider: 'claude', role: 'master', status: 'running' } as Agent,
        { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'idle' } as Agent,
        { agent_id: 'scout-1', provider: 'codex', role: 'scout', status: 'running', session_handle: 'pty:scout-1' } as Agent,
        { agent_id: 'scout-2', provider: 'claude', role: 'scout', status: 'idle' } as Agent,
      ],
    });
    writeConfig({ worker_pool: { max_workers: 1, provider: 'codex' } });
    writeEvents([]);

    const s = buildStatus(dir) as unknown as StatusResult;
    expect(s.worker_capacity.slots.map((slot) => slot.agent_id)).toEqual(['orc-1']);
    expect(s.scout_capacity.total_slots).toBe(2);
    expect(s.scout_capacity.investigating_slots).toBe(1);
    expect(s.scout_capacity.idle_slots).toBe(1);
    expect(s.scout_capacity.slots.map((slot) => slot.agent_id)).toEqual(['scout-1', 'scout-2']);
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
    const s = buildStatus(dir) as unknown as StatusResult;
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
          lease_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        } as Claim,
        {
          run_id: 'run-2',
          task_ref: 'a/2',
          agent_id: 'orc-1',
          state: 'done',
        } as Claim,
      ],
    });
    writeConfig({ worker_pool: { max_workers: 1, provider: 'codex' } });
    writeEvents([]);
    const s = buildStatus(dir) as unknown as StatusResult;
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
    const s = buildStatus(dir) as unknown as StatusResult;
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
    const s = buildStatus(dir) as unknown as StatusResult;
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
    const s = buildStatus(dir) as unknown as StatusResult;
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
    const s = buildStatus(dir) as unknown as StatusResult;
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

    const s = buildStatus(dir) as unknown as StatusResult;
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
    const s = buildStatus(dir) as unknown as StatusResult;
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
    const s = buildStatus(dir) as unknown as StatusResult;
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
    const s = buildStatus(dir) as unknown as StatusResult;
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
    const s = buildStatus(dir) as unknown as StatusResult;
    expect(s.claims.active[0].current_phase).toBeNull();
  });

  it('counts dispatch-ready work waiting for capacity', () => {
    writeState({
      agents: [{ agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running', session_handle: 'pty:orc-1' } as Agent],
      tasks: [
        { ref: 'orch/task-1', title: 'Task 1', status: 'todo' },
        { ref: 'orch/task-2', title: 'Task 2', status: 'todo', depends_on: ['orch/task-3'] },
        { ref: 'orch/task-3', title: 'Task 3', status: 'done' },
      ],
    });
    writeConfig({ worker_pool: { max_workers: 1, provider: 'codex' } });
    writeEvents([]);

    const s = buildStatus(dir) as unknown as StatusResult;
    expect(s.worker_capacity.dispatch_ready_count).toBe(2);
    expect(s.worker_capacity.available_slots).toBe(1);
    expect(s.worker_capacity.waiting_for_capacity).toBe(1);
  });

  it('treats pre-started idle worker sessions as available capacity', () => {
    writeState({
      agents: [{ agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running', session_handle: 'pty:orc-1' } as Agent],
    });
    writeConfig({ worker_pool: { max_workers: 1, provider: 'codex' } });
    writeEvents([]);

    const s = buildStatus(dir) as unknown as StatusResult;
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

    const s = buildStatus(dir) as unknown as StatusResult;
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

    const s = buildStatus(dir) as unknown as StatusResult;
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

    const s = buildStatus(dir) as unknown as StatusResult;
    expect(s.finalization.total).toBe(1);
    expect(s.finalization.blocked_finalize).toBe(1);
    expect(s.finalization.blocked_preserved[0].run_branch).toBe('task/run-finalize-1');
    expect(s.finalization.blocked_preserved[0].run_worktree_path).toBe('/tmp/orc-worktrees/run-finalize-1');
  });
});

describe('formatStatus', () => {
  it('produces a non-empty string', () => {
    writeState();
    writeEvents([]);
    const output = formatStatus(buildStatus(dir));
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('includes "Orchestrator Status" header', () => {
    writeState();
    writeEvents([]);
    expect(formatStatus(buildStatus(dir))).toContain('Orchestrator Status');
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
    const output = formatStatus(buildStatus(dir));
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

    const output = formatStatus(buildStatus(dir));
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

    const output = formatStatus(buildStatus(dir));
    expect(output).toContain('Finalization (1):');
    expect(output).toContain('blocked_preserved:        1');
    expect(output).toContain('preserved_work');
    expect(output).toContain('task/run-finalize-2');
    expect(output).toContain('/tmp/orc-worktrees/run-finalize-2');
  });

  it('renders a separate scout slots section', () => {
    writeState({
      agents: [
        { agent_id: 'master', provider: 'claude', role: 'master', status: 'running' } as Agent,
        { agent_id: 'scout-1', provider: 'codex', role: 'scout', status: 'running', session_handle: 'pty:scout-1' } as Agent,
        { agent_id: 'scout-2', provider: 'claude', role: 'scout', status: 'offline' } as Agent,
      ],
    });
    writeEvents([]);

    const output = formatStatus(buildStatus(dir));
    expect(output).toContain('scout-1');
    expect(output).toContain('scout-2');
    expect(output).toContain('scout    investigating');
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
