import { describe, expect, it } from 'vitest';
import { isCommitToolEvent, isExplicitPhaseEvent, isProgressLifecycleEvent, noProgressEscalationMs } from './runProgress.ts';

describe('isProgressLifecycleEvent', () => {
  it('counts lifecycle events of a run', () => {
    for (const event of ['run_started', 'review_submitted', 'work_complete', 'finalize_rebase_started', 'ready_to_merge', 'input_requested', 'input_provided']) {
      expect(isProgressLifecycleEvent({ event, run_id: 'r1' })).toBe(true);
    }
  });

  it('does not count heartbeats, phase events, or run-less events', () => {
    expect(isProgressLifecycleEvent({ event: 'heartbeat', run_id: 'r1' })).toBe(false);
    expect(isProgressLifecycleEvent({ event: 'phase_started', run_id: 'r1' })).toBe(false);
    expect(isProgressLifecycleEvent({ event: 'activity_note', run_id: 'r1' })).toBe(false);
    expect(isProgressLifecycleEvent({ event: 'run_started' })).toBe(false);
  });
});

describe('isCommitToolEvent', () => {
  const bash = (brief: string) => ({ type: 'tool' as const, tool: 'Bash', brief, ts: '2026-11-01T00:00:00.000Z' });

  it('detects git commit commands', () => {
    expect(isCommitToolEvent(bash('git commit -m "feat(a): b"'))).toBe(true);
    expect(isCommitToolEvent(bash('git add -A && git commit -m x'))).toBe(true);
    expect(isCommitToolEvent(bash('git -C ../repo commit --amend'))).toBe(true);
  });

  it('ignores other commands and tools', () => {
    expect(isCommitToolEvent(bash('git status'))).toBe(false);
    expect(isCommitToolEvent(bash('git log --grep=commit'))).toBe(false);
    expect(isCommitToolEvent(bash('npm test'))).toBe(false);
    expect(isCommitToolEvent({ type: 'tool', tool: 'Edit', brief: 'git commit', ts: '2026-11-01T00:00:00.000Z' })).toBe(false);
  });
});

describe('isExplicitPhaseEvent', () => {
  it('accepts worker phase events', () => {
    expect(isExplicitPhaseEvent({ event: 'phase_started', actor_type: 'agent', payload: { phase: 'review' } })).toBe(true);
    expect(isExplicitPhaseEvent({ event: 'phase_started', actor_type: 'agent' })).toBe(true);
  });

  it('rejects inferred phase events and other events', () => {
    expect(isExplicitPhaseEvent({ event: 'phase_started', actor_type: 'coordinator', payload: { phase: 'review', inferred: true } })).toBe(false);
    expect(isExplicitPhaseEvent({ event: 'phase_started', actor_type: 'agent', payload: { inferred: true } })).toBe(false);
    expect(isExplicitPhaseEvent({ event: 'heartbeat', actor_type: 'agent' })).toBe(false);
  });
});

describe('noProgressEscalationMs', () => {
  const nowMs = Date.parse('2026-11-01T12:00:00.000Z');
  const base = {
    progressAt: '2026-11-01T11:00:00.000Z',
    idleMs: 60_000,
    staleSoftMs: 600_000,
    thresholdMs: 1_800_000,
    notifiedFor: null,
    nowMs,
  };

  it('escalates a live run without progress past the threshold', () => {
    expect(noProgressEscalationMs(base)).toBe(3_600_000);
  });

  it('does not escalate before the threshold', () => {
    expect(noProgressEscalationMs({ ...base, progressAt: '2026-11-01T11:45:00.000Z' })).toBeNull();
  });

  it('leaves a stale run to the stale alert', () => {
    expect(noProgressEscalationMs({ ...base, idleMs: 600_000 })).toBeNull();
  });

  it('alerts once per progress timestamp and re-arms on new progress', () => {
    expect(noProgressEscalationMs({ ...base, notifiedFor: base.progressAt })).toBeNull();
    expect(noProgressEscalationMs({ ...base, notifiedFor: '2026-11-01T10:00:00.000Z' })).toBe(3_600_000);
  });

  it('ignores missing or invalid progress timestamps', () => {
    expect(noProgressEscalationMs({ ...base, progressAt: null })).toBeNull();
    expect(noProgressEscalationMs({ ...base, progressAt: 'not-a-date' })).toBeNull();
  });
});
