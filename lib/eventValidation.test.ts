import { describe, it, expect } from 'vitest';
import { validateEventObject } from './eventValidation.ts';

function base(event: string, extra: Record<string, unknown> = {}) {
  return {
    seq: 1,
    ts: '2026-01-01T00:00:00Z',
    event,
    actor_type: 'agent',
    actor_id: 'worker-01',
    ...extra,
  };
}

describe('validateEventObject', () => {
  it('accepts a valid task_delegated event', () => {
    const errors = validateEventObject(base('task_delegated', {
      actor_type: 'human',
      actor_id: 'human',
      task_ref: 'docs/task-1',
      payload: { task_type: 'implementation' },
    }));
    expect(errors).toEqual([]);
  });

  it('requires task_ref for task events', () => {
    const errors = validateEventObject(base('task_added'));
    expect(errors).toContain('task_ref is required and must match feature/task format');
  });

  it('requires run_id/task_ref/agent_id for run_started', () => {
    const errors = validateEventObject(base('run_started', { run_id: 'run-1', agent_id: 'INVALID' }));
    expect(errors).toContain('task_ref is required and must match feature/task format');
    expect(errors).toContain('agent_id is required and must be a valid agent_id');
  });

  it('accepts task_envelope_sent with run_id, task_ref, and agent_id', () => {
    const errors = validateEventObject(base('task_envelope_sent', {
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: {},
    }));
    expect(errors).toEqual([]);
  });

  it('accepts work_complete with run_id, task_ref, and agent_id', () => {
    const errors = validateEventObject(base('work_complete', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { status: 'awaiting_finalize', retry_count: 0 },
    }));
    expect(errors).toEqual([]);
  });

  it('accepts finalize_rebase_started and ready_to_merge finalization events', () => {
    const started = validateEventObject(base('finalize_rebase_started', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { status: 'finalize_rebase_in_progress', retry_count: 1 },
    }));
    const ready = validateEventObject(base('ready_to_merge', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { status: 'ready_to_merge', retry_count: 1 },
    }));
    expect(started).toEqual([]);
    expect(ready).toEqual([]);
  });

  it('also accepts finalize_rebase_started and ready_to_merge without retry_count', () => {
    const started = validateEventObject(base('finalize_rebase_started', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { status: 'finalize_rebase_in_progress' },
    }));
    const ready = validateEventObject(base('ready_to_merge', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { status: 'ready_to_merge' },
    }));
    expect(started).toEqual([]);
    expect(ready).toEqual([]);
  });

  it('rejects malformed finalization payload retry counts and statuses', () => {
    const badRetry = validateEventObject(base('ready_to_merge', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { status: 'ready_to_merge', retry_count: '1' },
    }));
    const badStatus = validateEventObject(base('finalize_rebase_started', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { status: 'awaiting_finalize', retry_count: 1 },
    }));
    expect(badRetry).toContain('payload.retry_count must be a non-negative integer');
    expect(badStatus).toContain('payload.status must be one of: finalize_rebase_in_progress');
  });

  it('accepts work_complete without retry_count for backward compatibility', () => {
    // Events emitted before the finalization contract landed lack retry_count.
    const errors = validateEventObject(base('work_complete', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { status: 'awaiting_finalize' },
    }));
    expect(errors).toEqual([]);
  });

  it('rejects work_complete with a present but invalid retry_count', () => {
    const errors = validateEventObject(base('work_complete', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { status: 'awaiting_finalize', retry_count: 'bad' },
    }));
    expect(errors).toContain('payload.retry_count must be a non-negative integer');
  });

  it('accepts heartbeat when either run_id or valid agent_id exists', () => {
    expect(validateEventObject(base('heartbeat', { run_id: 'run-1' }))).toEqual([]);
    expect(validateEventObject(base('heartbeat', { agent_id: 'worker-01' }))).toEqual([]);
  });

  it('rejects heartbeat with neither run_id nor valid agent_id', () => {
    const errors = validateEventObject(base('heartbeat', { agent_id: 'INVALID' }));
    expect(errors).toContain('heartbeat requires agent_id or run_id');
  });

  it('enforces lease_expires_at payload for claim_created', () => {
    const bad = validateEventObject(base('claim_created', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: {},
    }));
    expect(bad).toContain('payload.lease_expires_at must be an ISO date-time string');

    const ok = validateEventObject(base('claim_created', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { lease_expires_at: '2026-01-01T01:00:00Z' },
    }));
    expect(ok).toEqual([]);
  });

  it('enforces run_failed failure policy payload', () => {
    const bad = validateEventObject(base('run_failed', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { policy: 'ignore' },
    }));
    expect(bad).toContain('payload.policy must be requeue or block');
  });

  it('requires run_id/task_ref/agent_id for run_cancelled', () => {
    const errors = validateEventObject(base('run_cancelled', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { reason: 'cancelled' },
    }));
    expect(errors).toEqual([]);
  });

  it('requires task_ref for task_cancelled', () => {
    const errors = validateEventObject(base('task_cancelled', {
      actor_type: 'coordinator',
      actor_id: 'coordinator',
    }));
    expect(errors).toContain('task_ref is required and must match feature/task format');
  });

  it('enforces elapsed_ms payload for agent_marked_dead', () => {
    const bad = validateEventObject(base('agent_marked_dead', {
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      agent_id: 'worker-01',
      payload: {},
    }));
    expect(bad).toContain('payload.elapsed_ms must be a non-negative integer');

    const ok = validateEventObject(base('agent_marked_dead', {
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      agent_id: 'worker-01',
      payload: { elapsed_ms: 7_200_001 },
    }));
    expect(ok).toEqual([]);
  });

  it('requires run_id, task_ref, and reason for session_start_failed', () => {
    const bad = validateEventObject(base('session_start_failed', {
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      agent_id: 'worker-01',
      payload: {},
    }));
    expect(bad).toContain('run_id is required');
    expect(bad).toContain('task_ref is required and must match feature/task format');
    expect(bad).toContain('payload.reason must be a non-empty string');

    const ok = validateEventObject(base('session_start_failed', {
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { reason: 'spawn failed' },
    }));
    expect(ok).toEqual([]);
  });

  it('requires question payload for input_requested', () => {
    const bad = validateEventObject(base('input_requested', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: {},
    }));
    expect(bad).toContain('payload.question must be a non-empty string');
  });

  it('requires response payload for input_response', () => {
    const bad = validateEventObject(base('input_response', {
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: {},
    }));
    expect(bad).toContain('payload.response must be a non-empty string');
  });
});
