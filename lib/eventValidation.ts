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

function validateCoreEventInvariants(event: unknown, errors: string[]): void {
  const e = event as { event?: string; agent_id?: string; run_id?: string; payload?: Record<string, unknown> } | null;
  const eventName = e?.event;
  const taskEvents = new Set(['task_added', 'task_updated', 'task_cancelled', 'task_released', 'task_delegated', 'task_dispatch_blocked']);
  const runLifecycleEvents = new Set([
    'claim_created',
    'claim_renewed',
    'claim_expired',
    'claim_released',
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
    'input_requested',
    'input_response',
    'worker_needs_attention',
  ]);
  const agentEvents = new Set([
    'agent_registered',
    'agent_online',
    'agent_offline',
    'agent_marked_dead',
    'session_start_failed',
  ]);

  if (eventName && taskEvents.has(eventName)) {
    requireTaskRef(event, errors);
  }

  if (eventName && runLifecycleEvents.has(eventName)) {
    requireRunId(event, errors);
  }

  if (eventName && new Set([
    'claim_created',
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
  ]).has(eventName)) {
    requireTaskRef(event, errors);
    requireAgentId(event, errors);
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
  }

  if (eventName === 'input_response') {
    requirePayloadField(
      event,
      'response',
      (v) => typeof v === 'string' && v.length > 0,
      'must be a non-empty string',
      errors,
    );
  }

  if (eventName && agentEvents.has(eventName)) {
    requireAgentId(event, errors);
  }

  if (eventName === 'heartbeat') {
    const hasAgent = typeof e?.agent_id === 'string' && AGENT_ID_RE.test(e.agent_id);
    const hasRun = typeof e?.run_id === 'string';
    if (!hasAgent && !hasRun) {
      errors.push('heartbeat requires agent_id or run_id');
    }
  }

  if (eventName === 'claim_created' || eventName === 'claim_renewed') {
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

  if (eventName === 'worker_needs_attention') {
    requirePayloadField(
      event,
      'reason',
      (v) => v === 'stale',
      'must be "stale"',
      errors,
    );
    requirePayloadField(
      event,
      'idle_ms',
      (v) => Number.isInteger(v) && (v as number) >= 0,
      'must be a non-negative integer',
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
 */
export function validateEventObject(event: unknown): string[] {
  const ok = validateSchema(event);
  const errors = ok ? [] : formatAjvErrors(validateSchema.errors as AjvError[] | null);
  validateCoreEventInvariants(event, errors);
  return errors;
}
