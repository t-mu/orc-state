import { describe, it, expect, beforeEach } from 'vitest';
import { validateProgressInput } from './progressValidation.mjs';

let claimedRun;
let inProgressRun;

beforeEach(() => {
  claimedRun = {
    run_id: 'run-abc123',
    task_ref: 'docs/test',
    agent_id: 'bob',
    state: 'claimed',
    claimed_at: '2026-01-01T00:00:00Z',
    lease_expires_at: '2026-01-01T00:30:00Z',
    last_heartbeat_at: null,
    started_at: null,
    finished_at: null,
  };
  inProgressRun = {
    run_id: 'run-def456',
    task_ref: 'docs/test-2',
    agent_id: 'bob',
    state: 'in_progress',
    claimed_at: '2026-01-01T00:00:00Z',
    lease_expires_at: '2026-01-01T00:30:00Z',
    last_heartbeat_at: null,
    started_at: '2026-01-01T00:01:00Z',
    finished_at: null,
  };
});

describe('validateProgressInput', () => {
  it('accepts valid run_started input', () => {
    expect(() => validateProgressInput({
      event: 'run_started',
      runId: 'run-abc123',
      agentId: 'bob',
      phase: null,
      reason: null,
      policy: 'requeue',
    }, claimedRun)).not.toThrow();
  });

  it('rejects unknown event', () => {
    expect(() => validateProgressInput({
      event: 'unknown_event',
      runId: 'run-abc123',
      agentId: 'bob',
    }, claimedRun)).toThrow('Unsupported event');
  });

  it('rejects event for wrong agent', () => {
    expect(() => validateProgressInput({
      event: 'run_started',
      runId: 'run-abc123',
      agentId: 'alice',
    }, claimedRun)).toThrow('belongs to bob');
  });

  it('rejects phase event without phase', () => {
    expect(() => validateProgressInput({
      event: 'phase_started',
      runId: 'run-def456',
      agentId: 'bob',
    }, inProgressRun)).toThrow('requires --phase');
  });

  it('rejects blocked without reason', () => {
    expect(() => validateProgressInput({
      event: 'blocked',
      runId: 'run-def456',
      agentId: 'bob',
    }, inProgressRun)).toThrow('requires --reason');
  });

  it('rejects invalid run_failed policy', () => {
    expect(() => validateProgressInput({
      event: 'run_failed',
      runId: 'run-def456',
      agentId: 'bob',
      reason: 'nope',
      policy: 'drop',
    }, inProgressRun)).toThrow('Invalid failure policy');
  });

  it('rejects phase events before run_started', () => {
    expect(() => validateProgressInput({
      event: 'phase_started',
      runId: 'run-abc123',
      agentId: 'bob',
      phase: 'implementation',
    }, claimedRun)).toThrow('requires run_started first');
  });

  it('rejects run_started when run is already in_progress', () => {
    expect(() => validateProgressInput({
      event: 'run_started',
      runId: 'run-def456',
      agentId: 'bob',
    }, inProgressRun)).toThrow("requires claim state 'claimed'");
  });

  it('rejects when claim is missing', () => {
    expect(() => validateProgressInput({
      event: 'run_started',
      runId: 'run-def456',
      agentId: 'bob',
    }, null)).toThrow('Run not found in claims');
  });

  it('rejects run id mismatch between input and claim', () => {
    expect(() => validateProgressInput({
      event: 'run_started',
      runId: 'run-other',
      agentId: 'bob',
    }, claimedRun)).toThrow('Claim run_id mismatch');
  });

  it('accepts work_complete from a fresh run and from finalize_rebase_in_progress', () => {
    expect(() => validateProgressInput({
      event: 'work_complete',
      runId: 'run-def456',
      agentId: 'bob',
    }, inProgressRun)).not.toThrow();
    expect(() => validateProgressInput({
      event: 'work_complete',
      runId: 'run-def456',
      agentId: 'bob',
    }, { ...inProgressRun, finalization_state: 'finalize_rebase_in_progress' })).not.toThrow();
  });

  it('rejects work_complete from awaiting_finalize once the handoff already happened', () => {
    expect(() => validateProgressInput({
      event: 'work_complete',
      runId: 'run-def456',
      agentId: 'bob',
    }, { ...inProgressRun, finalization_state: 'awaiting_finalize' })).toThrow('requires no finalization state');
  });

  it('accepts finalize_rebase_started only from finalize_rebase_requested state', () => {
    expect(() => validateProgressInput({
      event: 'finalize_rebase_started',
      runId: 'run-def456',
      agentId: 'bob',
    }, { ...inProgressRun, finalization_state: 'finalize_rebase_requested' })).not.toThrow();
  });

  it('rejects finalize_rebase_started before a coordinator request', () => {
    expect(() => validateProgressInput({
      event: 'finalize_rebase_started',
      runId: 'run-def456',
      agentId: 'bob',
    }, { ...inProgressRun, finalization_state: 'awaiting_finalize' })).toThrow('finalize_rebase_requested');
  });

  it('accepts ready_to_merge only after finalize_rebase_started', () => {
    expect(() => validateProgressInput({
      event: 'ready_to_merge',
      runId: 'run-def456',
      agentId: 'bob',
    }, { ...inProgressRun, finalization_state: 'finalize_rebase_in_progress' })).not.toThrow();
    expect(() => validateProgressInput({
      event: 'ready_to_merge',
      runId: 'run-def456',
      agentId: 'bob',
    }, { ...inProgressRun, finalization_state: 'awaiting_finalize' })).toThrow('finalization_state');
  });
});
