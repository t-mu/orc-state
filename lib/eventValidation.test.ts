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

  it('validates session_resumed and session_resume_failed payloads and rejects unknown fields', () => {
    const fields = { actor_type: 'coordinator', actor_id: 'coordinator', agent_id: 'worker-01' };
    const payload = { session_id: 'sess-1', agent_id: 'worker-01', run_id: 'run-1', generation: 2, provider_conversation_id: 'conv-1' };
    expect(validateEventObject(base('session_resumed', { ...fields, run_id: 'run-1', payload }))).toEqual([]);
    expect(validateEventObject(base('session_resumed', { ...fields, payload: { session_id: 'sess-m', agent_id: 'master', generation: 0 } }))).toEqual([]);
    expect(validateEventObject(base('session_resume_failed', { ...fields, payload: { ...payload, reason: 'conversation expired' } }))).toEqual([]);
    expect(validateEventObject(base('session_resume_failed', { ...fields, payload })))
      .toContain('payload.reason must be a non-empty string');
    const bad = validateEventObject(base('session_resumed', { ...fields, payload: { session_id: '', generation: -1, provider_conversation_id: 5 } }));
    expect(bad).toEqual(expect.arrayContaining([
      'payload.session_id must be a non-empty string',
      'payload.agent_id must be a non-empty string',
      'payload.generation must be a non-negative integer',
      'payload.provider_conversation_id must be a non-empty string when present',
    ]));
    expect(validateEventObject(base('session_resumed', { actor_type: 'coordinator', actor_id: 'coordinator', payload })))
      .toContain('agent_id is required and must be a valid agent_id');
    expect(validateEventObject(base('session_resumed', { ...fields, payload, resumed_by: 'me' })))
      .toContain('(root) must NOT have additional properties');
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

  it('accepts a valid activity_note event and validates its payload', () => {
    const ok = validateEventObject(base('activity_note', {
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { label: 'Write tests', source: 'todo' },
    }));
    expect(ok).toEqual([]);

    const bad = validateEventObject(base('activity_note', {
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { label: '', source: 'other' },
    }));
    expect(bad).toContain('payload.label must be a non-empty string');
    expect(bad).toContain('payload.source must be one of: todo, note, tool');
  });

  it('accepts a valid stop_blocked event and validates its payload', () => {
    const fields = { actor_type: 'coordinator', actor_id: 'coordinator', run_id: 'run-1', task_ref: 'docs/task-1', agent_id: 'worker-01' };
    expect(validateEventObject(base('stop_blocked', { ...fields, payload: { phase: 'implement', count: 1, stop_hook_active: false } }))).toEqual([]);
    expect(validateEventObject(base('stop_blocked', { ...fields, payload: { phase: null, count: 3, stop_hook_active: true } }))).toEqual([]);

    const bad = validateEventObject(base('stop_blocked', { ...fields, payload: { phase: '', count: 0, stop_hook_active: 'yes' } }));
    expect(bad).toContain('payload.phase must be a non-empty string or null');
    expect(bad).toContain('payload.count must be a positive integer');
    expect(bad).toContain('payload.stop_hook_active must be a boolean');

    const unscoped = validateEventObject(base('stop_blocked', { actor_type: 'coordinator', actor_id: 'coordinator', payload: { phase: null, count: 1, stop_hook_active: false } }));
    expect(unscoped.length).toBeGreaterThan(0);
  });

  it('accepts stale and no_progress worker_needs_attention events', () => {
    const fields = { actor_type: 'coordinator', actor_id: 'coordinator', run_id: 'run-1', task_ref: 'docs/task-1', agent_id: 'worker-01' };
    expect(validateEventObject(base('worker_needs_attention', { ...fields, payload: { reason: 'stale', idle_ms: 1000 } }))).toEqual([]);
    expect(validateEventObject(base('worker_needs_attention', { ...fields, payload: { reason: 'no_progress', idle_ms: 1000, no_progress_ms: 1_800_000, phase: 'implement', progress_at: '2026-11-01T11:00:00.000Z' } }))).toEqual([]);

    expect(validateEventObject(base('worker_needs_attention', { ...fields, payload: { reason: 'no_progress', idle_ms: 1000 } })))
      .toContain('payload.no_progress_ms must be a non-negative integer');
    expect(validateEventObject(base('worker_needs_attention', { ...fields, payload: { reason: 'no_progress', idle_ms: 1000, no_progress_ms: 1 } })))
      .toContain('payload.progress_at must be an ISO timestamp');
    expect(validateEventObject(base('worker_needs_attention', { ...fields, payload: { reason: 'bored', idle_ms: 1000 } })))
      .toContain('payload.reason must be "stale" or "no_progress"');
  });

  describe('claim_expired', () => {
    const fields = { actor_type: 'coordinator', actor_id: 'coordinator', run_id: 'run-1', task_ref: 'orch/a' };
    const payload = { policy: 'requeue', code: 'ERR_LEASE_EXPIRED', reason: 'ERR_LEASE_EXPIRED', task_status: 'todo', attempt_count: 1, requeue_eligible_after: null, blocked_reason: null };

    it('accepts the unified payload with agent_id', () => {
      expect(validateEventObject(base('claim_expired', { ...fields, agent_id: 'worker-01', payload }))).toEqual([]);
    });

    it('rejects a claim_expired without agent_id', () => {
      expect(validateEventObject(base('claim_expired', { ...fields, payload })))
        .toContain('agent_id is required and must be a valid agent_id');
    });

    it('accepts a stored claim_expired of the older shapes (no agent_id, no code)', () => {
      expect(validateEventObject(base('claim_expired', { ...fields, payload: { policy: 'requeue', code: 'ERR_LEASE_EXPIRED' } }), { stored: true })).toEqual([]);
      expect(validateEventObject(base('claim_expired', { ...fields, agent_id: 'worker-01', payload: { reason: 'manual_expire', policy: 'requeue' } }), { stored: true })).toEqual([]);
    });

    it('rejects an empty code and mistyped task fields', () => {
      const errors = validateEventObject(base('claim_expired', {
        ...fields, agent_id: 'worker-01', payload: { policy: 'requeue', code: '', task_status: 3, attempt_count: -1 },
      }));
      expect(errors).toContain('payload.code must be a non-empty string');
      expect(errors).toContain('payload.task_status must be a string or null');
      expect(errors).toContain('payload.attempt_count must be a non-negative integer or null');
    });
  });

  describe('finalization_changed', () => {
    const fields = { actor_type: 'coordinator', actor_id: 'coordinator', run_id: 'run-1', task_ref: 'orch/a', agent_id: 'worker-01' };
    const payload = { from: 'awaiting_finalize', to: 'blocked_finalize', retry_count: 2, blocked_reason: 'conflict', pr_ref: null, pr_created_at: null };

    it('accepts a valid change', () => {
      expect(validateEventObject(base('finalization_changed', { ...fields, payload }))).toEqual([]);
      expect(validateEventObject(base('finalization_changed', { ...fields, payload: { ...payload, from: null } }))).toEqual([]);
    });

    it('rejects unknown states, a bad retry_count and a missing run identity', () => {
      const errors = validateEventObject(base('finalization_changed', {
        actor_type: 'coordinator', actor_id: 'coordinator', payload: { ...payload, to: 'merged', retry_count: -1 },
      }));
      expect(errors).toContain('run_id is required');
      expect(errors).toContain('agent_id is required and must be a valid agent_id');
      expect(errors.some((error) => error.startsWith('payload.to must be null or one of'))).toBe(true);
      expect(errors).toContain('payload.retry_count must be a non-negative integer');
    });
  });
});
