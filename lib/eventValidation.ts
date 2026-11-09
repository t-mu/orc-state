import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOrchestratorAjv } from './ajvFactory.ts';
import { type AjvError, formatAjvErrors } from './ajvUtils.ts';
import { AGENT_ID_RE, TASK_REF_RE } from './constants.ts';

const SCHEMA_DIR = join(import.meta.dirname, '..', 'schemas');
const EVENT_SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, 'event.schema.json'), 'utf8')) as object;

const ajv = createOrchestratorAjv();
const validateSchema = ajv.compile(EVENT_SCHEMA);
const FAILURE_POLICY_SET = new Set(['requeue', 'block']);
const COMMAND_EVENTS = new Set([
  'command_queued', 'command_dispatching', 'command_send_started', 'command_sent',
  'command_accepted', 'command_running', 'command_completed', 'command_failed',
  'command_cancelled', 'command_outcome_unknown',
]);

function requireTaskRef(event: unknown, errors: string[]): void {
  const e = event as { task_ref?: unknown } | null;
  if (!e?.task_ref || typeof e.task_ref !== 'string' || !TASK_REF_RE.test(e.task_ref)) {
    errors.push('task_ref is required and must match feature/task format');
  }
}

function requirePayloadField(
  event: unknown,
  key: string,
  validator: (v: unknown) => boolean,
  description: string,
  errors: string[],
): void {
  const e = event as { payload?: Record<string, unknown> } | null;
  const value = e?.payload?.[key];
  if (!validator(value)) {
    errors.push(`payload.${key} ${description}`);
  }
}

const FINALIZATION_STATUS_BY_EVENT: Record<string, Set<string>> = {
  work_complete: new Set(['awaiting_finalize']),
  finalize_rebase_started: new Set(['finalize_rebase_in_progress']),
  ready_to_merge: new Set(['ready_to_merge']),
};

const FINALIZATION_STATES = new Set([
  'awaiting_finalize', 'finalize_rebase_requested', 'finalize_rebase_in_progress', 'ready_to_merge',
  'blocked_finalize', 'pr_created', 'pr_review_in_progress', 'pr_merged', 'pr_failed',
]);

const EVENT_PHASES = new Set(['explore', 'implement', 'review', 'complete', 'finalize']);

function requireRunId(event: unknown, errors: string[]): void {
  const e = event as { run_id?: unknown } | null;
  if (!e?.run_id || typeof e.run_id !== 'string') {
    errors.push('run_id is required');
  }
}

function requireAgentId(event: unknown, errors: string[]): void {
  const e = event as { agent_id?: unknown } | null;
  if (!e?.agent_id || typeof e.agent_id !== 'string' || !AGENT_ID_RE.test(e.agent_id)) {
    errors.push('agent_id is required and must be a valid agent_id');
  }
}

function validateCoreEventInvariants(event: unknown, errors: string[], stored: boolean): void {
  const e = event as { event?: string; agent_id?: string; run_id?: string; payload?: Record<string, unknown> } | null;
  const eventName = e?.event;
  const taskEvents = new Set(['task_added', 'task_updated', 'task_cancelled', 'task_delegated', 'task_dispatch_blocked']);
  const runLifecycleEvents = new Set([
    'claim_created',
    'claim_expired',
    'task_envelope_sent',
    'run_started',
    'work_complete',
    'finalize_rebase_started',
    'ready_to_merge',
    'finalization_changed',
    'run_finished',
    'run_failed',
    'run_cancelled',
    'phase_started',
    'phase_finished',
    'blocked',
    'unblocked',
    'need_input',
    'input_provided',
    'input_requested',
    'input_response',
    'worker_needs_attention',
    'remediation_applied',
    'activity_note',
    'stop_blocked',
    ...COMMAND_EVENTS,
  ]);
  const agentEvents = new Set([
        'agent_registered',
        'agent_online',
        'reported_for_duty',
        'agent_offline',
        'agent_marked_dead',
        'session_start_failed',
        'session_opened',
        'session_state_changed',
        'session_reconciled',
        'session_resumed',
        'session_resume_failed',
        'master_retired',
        'scout_launched',
        'scout_launch_failed',
  ]);

  if (eventName && taskEvents.has(eventName)) {
    requireTaskRef(event, errors);
  }

  if (eventName && runLifecycleEvents.has(eventName)) {
    requireRunId(event, errors);
  }

  // Phase events carry a top-level `phase`; rows stored before it was required stay readable.
  if ((eventName === 'phase_started' || eventName === 'phase_finished') && !stored) {
    const phase = (event as { phase?: unknown } | null)?.phase;
    if (typeof phase !== 'string' || !EVENT_PHASES.has(phase)) {
      errors.push(`phase is required and must be one of: ${Array.from(EVENT_PHASES).join(', ')}`);
    }
  }

  // claim_expired gained a required agent_id; rows stored before that stay readable.
  if (eventName === 'claim_expired' && !stored) {
    requireAgentId(event, errors);
  }

  if (eventName && new Set([
    'claim_created',
    'finalization_changed',
    'task_envelope_sent',
    'run_started',
    'work_complete',
    'finalize_rebase_started',
    'ready_to_merge',
    'run_finished',
    'run_failed',
    'run_cancelled',
    'phase_started',
    'phase_finished',
    'blocked',
    'unblocked',
    'need_input',
    'input_provided',
    'worker_needs_attention',
    'remediation_applied',
    'activity_note',
    'stop_blocked',
    ...COMMAND_EVENTS,
  ]).has(eventName)) {
    requireTaskRef(event, errors);
    requireAgentId(event, errors);
  }

  if (eventName === 'session_reconciled') {
    requirePayloadField(event, 'session_id', (v) => typeof v === 'string' && v.length > 0, 'must be a non-empty string', errors);
    requirePayloadField(event, 'state', (v) => typeof v === 'string' && v.length > 0, 'must be a non-empty string', errors);
  }

  if (eventName === 'session_opened' || eventName === 'session_state_changed') {
    const nonEmpty = (v: unknown) => typeof v === 'string' && v.length > 0;
    requirePayloadField(event, 'session_id', nonEmpty, 'must be a non-empty string', errors);
    requirePayloadField(event, 'agent_id', nonEmpty, 'must be a non-empty string', errors);
    requirePayloadField(event, 'generation', (v) => Number.isInteger(v) && (v as number) >= 0, 'must be a non-negative integer', errors);
    requirePayloadField(event, 'run_id', (v) => v === undefined || nonEmpty(v), 'must be a non-empty string when present', errors);
    if (eventName === 'session_opened') {
      requirePayloadField(event, 'state', nonEmpty, 'must be a non-empty string', errors);
    } else {
      requirePayloadField(event, 'from', nonEmpty, 'must be a non-empty string', errors);
      requirePayloadField(event, 'to', nonEmpty, 'must be a non-empty string', errors);
      requirePayloadField(event, 'reason', (v) => v === undefined || nonEmpty(v), 'must be a non-empty string when present', errors);
    }
  }

  if (eventName === 'scout_launch_failed') {
    requirePayloadField(event, 'reason', (v) => typeof v === 'string' && v.length > 0, 'must be a non-empty string', errors);
  }

  if (eventName === 'master_retired') {
    requirePayloadField(event, 'probe', (v) => typeof v === 'object' && v !== null && typeof (v as { alive?: unknown }).alive === 'boolean',
      'must be an object with a boolean alive', errors);
    requirePayloadField(event, 'consecutive_failures', (v) => Number.isInteger(v) && (v as number) >= 0, 'must be a non-negative integer', errors);
  }

  if (eventName === 'session_resumed' || eventName === 'session_resume_failed') {
    const nonEmpty = (v: unknown) => typeof v === 'string' && v.length > 0;
    const optional = (v: unknown) => v === undefined || nonEmpty(v);
    requirePayloadField(event, 'session_id', nonEmpty, 'must be a non-empty string', errors);
    requirePayloadField(event, 'agent_id', nonEmpty, 'must be a non-empty string', errors);
    requirePayloadField(event, 'generation', (v) => Number.isInteger(v) && (v as number) >= 0, 'must be a non-negative integer', errors);
    requirePayloadField(event, 'run_id', optional, 'must be a non-empty string when present', errors);
    requirePayloadField(event, 'provider_conversation_id', optional, 'must be a non-empty string when present', errors);
    requirePayloadField(event, 'reason', eventName === 'session_resume_failed' ? nonEmpty : optional,
      eventName === 'session_resume_failed' ? 'must be a non-empty string' : 'must be a non-empty string when present', errors);
  }

  if (eventName && COMMAND_EVENTS.has(eventName)) {
    requirePayloadField(event, 'command_id', (v) => typeof v === 'string' && v.length > 0, 'must be a non-empty string', errors);
    requirePayloadField(event, 'state', (v) => typeof v === 'string' && v.length > 0, 'must be a non-empty string', errors);
  }

  if (eventName && new Set(['input_requested', 'input_response']).has(eventName)) {
    requireRunId(event, errors);
    requireAgentId(event, errors);
  }

  if (eventName === 'input_requested') {
    requirePayloadField(
      event,
      'question',
      (v) => typeof v === 'string' && v.length > 0,
      'must be a non-empty string',
      errors,
    );
    const payload = (e as { payload?: Record<string, unknown> } | null)?.payload;
    if (payload?.request_id !== undefined && typeof payload.request_id !== 'string') {
      errors.push('payload.request_id must be a string when present');
    }
  }

  if (eventName === 'input_response') {
    requirePayloadField(
      event,
      'response',
      (v) => typeof v === 'string' && v.length > 0,
      'must be a non-empty string',
      errors,
    );
    const payload = (e as { payload?: Record<string, unknown> } | null)?.payload;
    if (payload?.request_id !== undefined && typeof payload.request_id !== 'string' && payload.request_id !== null) {
      errors.push('payload.request_id must be a string or null when present');
    }
  }

  if (eventName && agentEvents.has(eventName)) {
    requireAgentId(event, errors);
  }

  if (eventName === 'reported_for_duty') {
    requirePayloadField(
      event,
      'session_token',
      (v) => typeof v === 'string' && v.length > 0,
      'must be a non-empty string',
      errors,
    );
  }

  if (eventName === 'heartbeat') {
    const hasAgent = typeof e?.agent_id === 'string' && AGENT_ID_RE.test(e.agent_id);
    const hasRun = typeof e?.run_id === 'string';
    if (!hasAgent && !hasRun) {
      errors.push('heartbeat requires agent_id or run_id');
    }
  }

  if (eventName === 'claim_created') {
    requirePayloadField(
      event,
      'lease_expires_at',
      (v) => typeof v === 'string' && Number.isFinite(new Date(v).getTime()),
      'must be an ISO date-time string',
      errors,
    );
  }

  if (eventName === 'claim_expired' || eventName === 'run_failed') {
    requirePayloadField(
      event,
      'policy',
      (v) => typeof v === 'string' && FAILURE_POLICY_SET.has(v),
      'must be requeue or block',
      errors,
    );
    // The resulting task fields are optional (events written before they existed lack them) but typed when present.
    const payload = (e as { payload?: Record<string, unknown> } | null)?.payload ?? {};
    for (const key of ['task_status', 'requeue_eligible_after', 'blocked_reason']) {
      if (payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== 'string') {
        errors.push(`payload.${key} must be a string or null`);
      }
    }
    if (payload.attempt_count !== undefined && payload.attempt_count !== null
      && !(Number.isInteger(payload.attempt_count) && (payload.attempt_count as number) >= 0)) {
      errors.push('payload.attempt_count must be a non-negative integer or null');
    }
  }

  if (eventName === 'claim_expired') {
    const code = (e as { payload?: Record<string, unknown> } | null)?.payload?.code;
    if (code !== undefined && !(typeof code === 'string' && code.length > 0)) {
      errors.push('payload.code must be a non-empty string');
    }
  }

  if (eventName === 'finalization_changed') {
    for (const key of ['from', 'to']) {
      requirePayloadField(
        event,
        key,
        (v) => v === null || (typeof v === 'string' && FINALIZATION_STATES.has(v)),
        `must be null or one of: ${Array.from(FINALIZATION_STATES).join(', ')}`,
        errors,
      );
    }
    requirePayloadField(event, 'retry_count', (v) => Number.isInteger(v) && (v as number) >= 0, 'must be a non-negative integer', errors);
    for (const key of ['blocked_reason', 'pr_ref', 'pr_created_at']) {
      requirePayloadField(event, key, (v) => v === null || typeof v === 'string', 'must be a string or null', errors);
    }
  }

  if (eventName === 'task_updated') {
    requirePayloadField(
      event,
      'status',
      (v) => typeof v === 'string' && v.length > 0,
      'must be a non-empty string',
      errors,
    );
  }

  if (eventName === 'agent_marked_dead') {
    requirePayloadField(
      event,
      'elapsed_ms',
      (v) => Number.isInteger(v) && (v as number) >= 0,
      'must be a non-negative integer',
      errors,
    );
  }

  if (eventName === 'session_start_failed') {
    requireRunId(event, errors);
    requireTaskRef(event, errors);
    requirePayloadField(
      event,
      'reason',
      (v) => typeof v === 'string' && v.length > 0,
      'must be a non-empty string',
      errors,
    );
  }

  if (eventName === 'session_started') {
    requirePayloadField(
      event,
      'session_id',
      (v) => typeof v === 'string' && v.length > 0,
      'must be a non-empty string',
      errors,
    );
    requirePayloadField(
      event,
      'reset_tasks',
      (v) => Number.isInteger(v) && (v as number) >= 0,
      'must be a non-negative integer',
      errors,
    );
    requirePayloadField(
      event,
      'reset_claims',
      (v) => Number.isInteger(v) && (v as number) >= 0,
      'must be a non-negative integer',
      errors,
    );
    requirePayloadField(
      event,
      'reset_agents',
      (v) => Number.isInteger(v) && (v as number) >= 0,
      'must be a non-negative integer',
      errors,
    );
  }

  if (eventName === 'worker_needs_attention') {
    requirePayloadField(
      event,
      'reason',
      (v) => v === 'stale' || v === 'no_progress' || v === 'session_not_running',
      'must be "stale", "no_progress" or "session_not_running"',
      errors,
    );
    if ((event as { payload?: { reason?: unknown } } | null)?.payload?.reason === 'no_progress') {
      requirePayloadField(
        event,
        'no_progress_ms',
        (v) => Number.isInteger(v) && (v as number) >= 0,
        'must be a non-negative integer',
        errors,
      );
      requirePayloadField(
        event,
        'progress_at',
        (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)),
        'must be an ISO timestamp',
        errors,
      );
    }
    if ((event as { payload?: { reason?: unknown } } | null)?.payload?.reason === 'session_not_running') {
      requirePayloadField(event, 'session_id', (v) => typeof v === 'string' && v.length > 0, 'must be a non-empty string', errors);
      requirePayloadField(event, 'session_state', (v) => typeof v === 'string' && v.length > 0, 'must be a non-empty string', errors);
      requirePayloadField(
        event,
        'not_running_ms',
        (v) => Number.isInteger(v) && (v as number) >= 0,
        'must be a non-negative integer',
        errors,
      );
    } else {
      requirePayloadField(
        event,
        'idle_ms',
        (v) => Number.isInteger(v) && (v as number) >= 0,
        'must be a non-negative integer',
        errors,
      );
    }
  }

  if (eventName === 'stop_blocked') {
    requirePayloadField(event, 'phase', (v) => v === null || (typeof v === 'string' && v.length > 0), 'must be a non-empty string or null', errors);
    requirePayloadField(event, 'count', (v) => Number.isInteger(v) && (v as number) >= 1, 'must be a positive integer', errors);
    requirePayloadField(event, 'stop_hook_active', (v) => typeof v === 'boolean', 'must be a boolean', errors);
  }

  if (eventName === 'activity_note') {
    requirePayloadField(event, 'label', (v) => typeof v === 'string' && v.length > 0, 'must be a non-empty string', errors);
    requirePayloadField(
      event,
      'source',
      // `tool` is no longer emitted (tool labels stay in run-activity.json) but stays valid for older events.
      (v) => v === 'todo' || v === 'note' || v === 'tool',
      'must be one of: todo, note, tool',
      errors,
    );
  }

  if (eventName === 'remediation_applied') {
    requirePayloadField(
      event,
      'policy_id',
      (v) => typeof v === 'string' && v.length > 0,
      'must be a non-empty string',
      errors,
    );
    requirePayloadField(
      event,
      'action',
      (v) => typeof v === 'string' && v.length > 0,
      'must be a non-empty string',
      errors,
    );
    requirePayloadField(
      event,
      'message',
      (v) => typeof v === 'string' && v.length > 0,
      'must be a non-empty string',
      errors,
    );
  }

  if (eventName && new Set(['work_complete', 'finalize_rebase_started', 'ready_to_merge']).has(eventName)) {
    requirePayloadField(
      event,
      'status',
      (v) => typeof v === 'string' && FINALIZATION_STATUS_BY_EVENT[eventName].has(v),
      `must be one of: ${Array.from(FINALIZATION_STATUS_BY_EVENT[eventName]).join(', ')}`,
      errors,
    );
    // retry_count is optional for worker-emitted finalization signals because
    // the coordinator owns retry bookkeeping. If present, it must still be valid.
    const payload = (e as { payload?: Record<string, unknown> } | null)?.payload;
    const retryCountValue = payload?.retry_count;
    const retryCountAbsent = retryCountValue === undefined;
    const retryCountValid = Number.isInteger(retryCountValue) && (retryCountValue as number) >= 0;
    if (!retryCountAbsent && !retryCountValid) {
      errors.push('payload.retry_count must be a non-negative integer');
    }
  }
}

/**
 * Validate one event object against schema + event-specific payload contract.
 * Returns an array of human-readable errors (empty when valid).
 * `stored: true` checks a row read back from events.db: a rule added after the
 * row was written (a `claim_expired` without `agent_id`) does not reject it.
 */
export function validateEventObject(event: unknown, { stored = false }: { stored?: boolean } = {}): string[] {
  const ok = validateSchema(event);
  const errors = ok ? [] : formatAjvErrors(validateSchema.errors as AjvError[] | null);
  validateCoreEventInvariants(event, errors, stored);
  return errors;
}
