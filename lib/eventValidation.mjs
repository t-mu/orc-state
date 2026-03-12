import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOrchestratorAjv } from './ajvFactory.mjs';

const SCHEMA_DIR = join(import.meta.dirname, '..', 'schemas');
const EVENT_SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, 'event.schema.json'), 'utf8'));

const ajv = createOrchestratorAjv();
const validateSchema = ajv.compile(EVENT_SCHEMA);

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const TASK_REF_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const FAILURE_POLICY_SET = new Set(['requeue', 'block']);

function formatAjvErrors(errors) {
  return (errors ?? []).map((err) => {
    const path = err.instancePath?.length ? err.instancePath : '(root)';
    return `${path} ${err.message}`;
  });
}

function requireTaskRef(event, errors) {
  if (!event?.task_ref || !TASK_REF_RE.test(event.task_ref)) {
    errors.push('task_ref is required and must match epic/task format');
  }
}

function requirePayloadField(event, key, validator, description, errors) {
  const value = event?.payload?.[key];
  if (!validator(value)) {
    errors.push(`payload.${key} ${description}`);
  }
}

const FINALIZATION_STATUS_BY_EVENT = {
  work_complete: new Set(['awaiting_finalize']),
  finalize_rebase_started: new Set(['finalize_rebase_in_progress']),
  ready_to_merge: new Set(['ready_to_merge']),
};

function requireRunId(event, errors) {
  if (!event?.run_id || typeof event.run_id !== 'string') {
    errors.push('run_id is required');
  }
}

function requireAgentId(event, errors) {
  if (!event?.agent_id || !AGENT_ID_RE.test(event.agent_id)) {
    errors.push('agent_id is required and must be a valid agent_id');
  }
}

function validateCoreEventInvariants(event, errors) {
  const eventName = event?.event;
  const taskEvents = new Set(['task_added', 'task_updated', 'task_cancelled', 'task_released', 'task_delegated']);
  const runLifecycleEvents = new Set([
    'claim_created',
    'claim_renewed',
    'claim_expired',
    'claim_released',
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
  ]);
  const agentEvents = new Set([
    'agent_registered',
    'agent_online',
    'agent_offline',
    'agent_marked_dead',
    'session_start_failed',
  ]);

  if (taskEvents.has(eventName)) {
    requireTaskRef(event, errors);
  }

  if (runLifecycleEvents.has(eventName)) {
    requireRunId(event, errors);
  }

  if (new Set([
    'claim_created',
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
  ]).has(eventName)) {
    requireTaskRef(event, errors);
    requireAgentId(event, errors);
  }

  if (new Set(['input_requested', 'input_response']).has(eventName)) {
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

  if (agentEvents.has(eventName)) {
    requireAgentId(event, errors);
  }

  if (eventName === 'heartbeat') {
    const hasAgent = typeof event?.agent_id === 'string' && AGENT_ID_RE.test(event.agent_id);
    const hasRun = typeof event?.run_id === 'string';
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
      (v) => Number.isInteger(v) && v >= 0,
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

  if (new Set(['work_complete', 'finalize_rebase_started', 'ready_to_merge']).has(eventName)) {
    requirePayloadField(
      event,
      'status',
      (v) => typeof v === 'string' && FINALIZATION_STATUS_BY_EVENT[eventName].has(v),
      `must be one of: ${Array.from(FINALIZATION_STATUS_BY_EVENT[eventName]).join(', ')}`,
      errors,
    );
    // retry_count is required for new finalization events; work_complete accepts absent
    // for backward compatibility with events emitted before the finalization contract landed.
    const retryCountValue = event?.payload?.retry_count;
    const retryCountAbsent = retryCountValue === undefined;
    const retryCountValid = Number.isInteger(retryCountValue) && retryCountValue >= 0;
    if (eventName === 'work_complete') {
      if (!retryCountAbsent && !retryCountValid) {
        errors.push('payload.retry_count must be a non-negative integer');
      }
    } else if (!retryCountValid) {
      errors.push('payload.retry_count must be a non-negative integer');
    }
  }
}

/**
 * Validate one event object against schema + event-specific payload contract.
 * Returns an array of human-readable errors (empty when valid).
 */
export function validateEventObject(event) {
  const ok = validateSchema(event);
  const errors = ok ? [] : formatAjvErrors(validateSchema.errors);
  validateCoreEventInvariants(event, errors);
  return errors;
}
