/**
 * Remediation policies — configurable signal→action rules evaluated by the
 * coordinator when an in_progress run is idle.  Pure matching logic lives here;
 * action execution stays in coordinator.ts where it has access to adapters,
 * emit(), and claim-manager primitives.
 */
import type { Agent } from '../types/agents.ts';
import type { Claim } from '../types/claims.ts';
import { intFlag } from './args.ts';

// ── Public types ──────────────────────────────────────────────────────────

export type RemediationAction =
  | 'record_input'
  | 'nudge_targeted'
  | 'requeue_now'
  | 'block'
  | 'escalate';

export interface RemediationSignals {
  claim: Claim;
  agent: Agent;
  idleMs: number;
  phase: string | null;
  phaseChanged: boolean;
  hookEvents: Array<{ message?: string }>;
  blockingPrompt: string | null;
  sessionAlive: boolean;
  attemptCount: number;
  nudgeCount: number;
}

export interface RemediationPolicy {
  id: string;
  description: string;
  match: (signals: RemediationSignals) => boolean;
  action: RemediationAction;
  message: string | ((signals: RemediationSignals) => string);
}

export interface RemediationResult {
  policy: RemediationPolicy;
  message: string;
}

// ── Configuration ─────────────────────────────────────────────────────────

export function loadRemediationConfig(argv?: string[]) {
  return {
    maxAttempts: intFlag('remediation-max-attempts', 3, argv),
    phaseStuckMs: intFlag('remediation-phase-stuck-ms', 1_200_000, argv),  // 20 min
    maxNudges: intFlag('remediation-max-nudges', 3, argv),
    disabledPolicies: new Set(
      (argv ?? process.argv.slice(2))
        .filter((a) => a.startsWith('--remediation-disable='))
        .flatMap((a) => a.split('=').slice(1).join('=').split(',')),
    ),
  };
}

export type RemediationConfig = ReturnType<typeof loadRemediationConfig>;

// ── Built-in policies ─────────────────────────────────────────────────────

export function builtinPolicies(config: RemediationConfig): RemediationPolicy[] {
  const all: RemediationPolicy[] = [
    {
      id: 'session_dead',
      description: 'PTY session process is no longer alive',
      match: (s) => !s.sessionAlive,
      action: 'requeue_now',
      message: 'worker PTY session is dead; requeueing task',
    },
    {
      id: 'permission_prompt',
      description: 'Blocking permission prompt detected in worker session',
      match: (s) => s.blockingPrompt != null || s.hookEvents.length > 0,
      action: 'record_input',
      message: (s) => s.blockingPrompt ?? s.hookEvents[0]?.message ?? 'permission prompt detected',
    },
    {
      id: 'repeated_failure',
      description: 'Task has failed too many times',
      match: (s) => s.attemptCount >= config.maxAttempts,
      action: 'block',
      message: (s) => `task blocked after ${s.attemptCount} failed attempts`,
    },
    {
      id: 'phase_stuck',
      description: 'Worker stuck in same phase with no progress after nudges started',
      match: (s) => s.nudgeCount > 0 && !s.phaseChanged && s.idleMs >= config.phaseStuckMs,
      action: 'nudge_targeted',
      message: (s) => s.phase
        ? `No progress in phase "${s.phase}" for ${Math.round(s.idleMs / 1000)}s. Check if you are blocked and need help.`
        : `No progress detected for ${Math.round(s.idleMs / 1000)}s. Have you started exploring the task spec?`,
    },
    {
      id: 'excessive_nudges',
      description: 'Multiple nudges sent with no phase advance',
      match: (s) => s.nudgeCount >= config.maxNudges && !s.phaseChanged,
      action: 'requeue_now',
      message: (s) => `no progress after ${s.nudgeCount} nudges; requeueing task`,
    },
  ];

  return all.filter((p) => !config.disabledPolicies.has(p.id));
}

// ── Evaluation ────────────────────────────────────────────────────────────

/**
 * Evaluate policies in priority order. Returns the first match, or null.
 * A throwing match() is caught and skipped — policy failures never block
 * the caller's timeout safety net.
 */
export function evaluateRemediationPolicies(
  policies: RemediationPolicy[],
  signals: RemediationSignals,
): RemediationResult | null {
  for (const policy of policies) {
    try {
      if (!policy.match(signals)) continue;
    } catch {
      continue;
    }
    const message = typeof policy.message === 'function'
      ? policy.message(signals)
      : policy.message;
    return { policy, message };
  }
  return null;
}
