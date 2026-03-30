import { describe, it, expect } from 'vitest';
import { builtinPolicies, evaluateRemediationPolicies, loadRemediationConfig } from './remediationPolicies.ts';
import type { RemediationSignals, RemediationPolicy } from './remediationPolicies.ts';


function baseSignals(overrides: Partial<RemediationSignals> = {}): RemediationSignals {
  return {
    claim: {
      run_id: 'run-test',
      task_ref: 'feat/task-1',
      agent_id: 'worker-01',
      state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00Z',
      lease_expires_at: '2026-01-01T01:00:00Z',
    },
    agent: {
      agent_id: 'worker-01',
      provider: 'claude',
      status: 'running',
      registered_at: '2026-01-01T00:00:00Z',
      session_handle: 'claude:session:worker-01',
    },
    idleMs: 0,
    phase: null,
    phaseChanged: false,
    hookEvents: [],
    blockingPrompt: null,
    sessionAlive: true,
    attemptCount: 0,
    nudgeCount: 0,
    ...overrides,
  };
}

describe('evaluateRemediationPolicies', () => {
  const config = loadRemediationConfig([]);
  const policies = builtinPolicies(config);

  it('returns null when no policy matches', () => {
    const result = evaluateRemediationPolicies(policies, baseSignals());
    expect(result).toBeNull();
  });

  it('matches session_dead when sessionAlive is false', () => {
    const result = evaluateRemediationPolicies(policies, baseSignals({ sessionAlive: false }));
    expect(result).not.toBeNull();
    expect(result!.policy.id).toBe('session_dead');
    expect(result!.policy.action).toBe('requeue_now');
  });

  it('matches permission_prompt when blockingPrompt is set', () => {
    const result = evaluateRemediationPolicies(policies, baseSignals({
      blockingPrompt: 'Allow access?',
    }));
    expect(result).not.toBeNull();
    expect(result!.policy.id).toBe('permission_prompt');
    expect(result!.policy.action).toBe('record_input');
    expect(result!.message).toBe('Allow access?');
  });

  it('matches permission_prompt when hookEvents are present', () => {
    const result = evaluateRemediationPolicies(policies, baseSignals({
      hookEvents: [{ message: 'hook: permission dialog' }],
    }));
    expect(result).not.toBeNull();
    expect(result!.policy.id).toBe('permission_prompt');
    expect(result!.message).toBe('hook: permission dialog');
  });

  it('matches repeated_failure when attemptCount >= threshold', () => {
    const result = evaluateRemediationPolicies(policies, baseSignals({ attemptCount: 3 }));
    expect(result).not.toBeNull();
    expect(result!.policy.id).toBe('repeated_failure');
    expect(result!.policy.action).toBe('block');
  });

  it('does not match repeated_failure when attemptCount < threshold', () => {
    const result = evaluateRemediationPolicies(policies, baseSignals({ attemptCount: 2 }));
    // Only repeated_failure checks attemptCount; other policies shouldn't match
    // with defaults (sessionAlive=true, no prompts, no nudges, idleMs=0)
    expect(result).toBeNull();
  });

  it('matches phase_stuck when idle exceeds threshold, phase unchanged, and nudges started', () => {
    const result = evaluateRemediationPolicies(policies, baseSignals({
      idleMs: 1_200_001,
      phase: 'implement',
      phaseChanged: false,
      nudgeCount: 1,
    }));
    expect(result).not.toBeNull();
    expect(result!.policy.id).toBe('phase_stuck');
    expect(result!.policy.action).toBe('nudge_targeted');
    expect(result!.message).toContain('implement');
  });

  it('does not match phase_stuck when phase changed', () => {
    const result = evaluateRemediationPolicies(policies, baseSignals({
      idleMs: 1_200_001,
      phase: 'review',
      phaseChanged: true,
      nudgeCount: 1,
    }));
    expect(result).toBeNull();
  });

  it('matches excessive_nudges when nudgeCount >= threshold and no phase change', () => {
    const result = evaluateRemediationPolicies(policies, baseSignals({
      nudgeCount: 3,
      phaseChanged: false,
    }));
    expect(result).not.toBeNull();
    expect(result!.policy.id).toBe('excessive_nudges');
    expect(result!.policy.action).toBe('requeue_now');
  });

  it('excessive_nudges wins over phase_stuck when nudge budget exhausted', () => {
    const result = evaluateRemediationPolicies(policies, baseSignals({
      idleMs: 1_200_001,
      phase: 'implement',
      phaseChanged: false,
      nudgeCount: 3,
    }));
    expect(result).not.toBeNull();
    expect(result!.policy.id).toBe('excessive_nudges');
    expect(result!.policy.action).toBe('requeue_now');
  });

  it('does not match excessive_nudges when phase changed', () => {
    const result = evaluateRemediationPolicies(policies, baseSignals({
      nudgeCount: 5,
      phaseChanged: true,
    }));
    expect(result).toBeNull();
  });

  it('first match wins (priority ordering)', () => {
    // session_dead has higher priority than permission_prompt
    const result = evaluateRemediationPolicies(policies, baseSignals({
      sessionAlive: false,
      blockingPrompt: 'Allow?',
    }));
    expect(result!.policy.id).toBe('session_dead');
  });

  it('skips a throwing match function gracefully', () => {
    const badPolicy: RemediationPolicy = {
      id: 'bad',
      match: () => { throw new Error('boom'); },
      action: 'requeue_now',
      message: 'bad',
    };
    const goodPolicy: RemediationPolicy = {
      id: 'good',
      match: () => true,
      action: 'requeue_now',
      message: 'caught',
    };
    const result = evaluateRemediationPolicies([badPolicy, goodPolicy], baseSignals());
    expect(result).not.toBeNull();
    expect(result!.policy.id).toBe('good');
  });
});

describe('loadRemediationConfig', () => {
  it('uses defaults when no flags', () => {
    const config = loadRemediationConfig([]);
    expect(config.maxAttempts).toBe(3);
    expect(config.phaseStuckMs).toBe(1_200_000);
    expect(config.maxNudges).toBe(3);
  });

  it('parses CLI flags', () => {
    const config = loadRemediationConfig([
      '--remediation-max-attempts=5',
      '--remediation-phase-stuck-ms=60000',
      '--remediation-max-nudges=10',
    ]);
    expect(config.maxAttempts).toBe(5);
    expect(config.phaseStuckMs).toBe(60000);
    expect(config.maxNudges).toBe(10);
  });
});
