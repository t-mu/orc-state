import type { Claim, FinalizationState } from '../types/claims.ts';

const SUPPORTED_EVENTS = new Set([
  'run_started',
  'heartbeat',
  'work_complete',
  'finalize_rebase_started',
  'ready_to_merge',
  'run_finished',
  'run_failed',
  'phase_started',
  'phase_finished',
  'blocked',
  'need_input',
  'input_provided',
  'unblocked',
]);

const EVENTS_REQUIRING_PHASE = new Set(['phase_started', 'phase_finished']);
const EVENTS_REQUIRING_REASON = new Set(['run_failed', 'blocked', 'need_input']);
const EVENTS_REQUIRING_IN_PROGRESS = new Set([
  'heartbeat',
  'work_complete',
  'finalize_rebase_started',
  'ready_to_merge',
  'run_finished',
  'run_failed',
  'phase_started',
  'phase_finished',
  'blocked',
  'need_input',
  'input_provided',
  'unblocked',
]);

export interface ProgressInput {
  event: string;
  runId: string;
  agentId: string;
  phase?: string | null;
  reason?: string | null;
  policy?: string | null;
}

/**
 * Validate worker command arguments without enforcing shared-state transitions.
 * Use this on the worker side so the coordinator remains the source of truth
 * for lifecycle state transitions.
 */
export function validateProgressCommandInput(input: ProgressInput, claim: Claim | null | undefined): { claim: Claim } {
  const { event, runId, agentId, phase, reason, policy } = input;
  if (!event || !runId || !agentId) {
    throw new Error('event, run-id, and agent-id are required');
  }
  if (!SUPPORTED_EVENTS.has(event)) {
    throw new Error(`Unsupported event: ${event}`);
  }
  if (!/^run-[a-z0-9-]+$/.test(runId)) {
    throw new Error(`Invalid run-id: ${runId}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId)) {
    throw new Error(`Invalid agent-id: ${agentId}`);
  }
  if (!claim) {
    throw new Error(`Run not found in claims: ${runId}`);
  }
  if (claim.run_id !== runId) {
    throw new Error(`Claim run_id mismatch: expected ${runId}`);
  }
  if (claim.agent_id !== agentId) {
    throw new Error(`Run ${runId} belongs to ${claim.agent_id}, not ${agentId}`);
  }
  if (EVENTS_REQUIRING_PHASE.has(event) && !phase) {
    throw new Error(`Event ${event} requires --phase=<name>`);
  }
  if (EVENTS_REQUIRING_REASON.has(event) && !reason) {
    throw new Error(`Event ${event} requires --reason=<text>`);
  }
  if (event === 'run_failed' && !['requeue', 'block'].includes(policy ?? 'requeue')) {
    throw new Error(`Invalid failure policy: ${String(policy)}. Use requeue or block.`);
  }

  return { claim };
}

/**
 * Validate incoming worker progress event arguments against active run state.
 * Throws with actionable errors for malformed or inconsistent inputs.
 */
export function validateProgressInput(input: ProgressInput, claim: Claim | null | undefined): { claim: Claim } {
  const { event, runId, agentId, phase, reason, policy } = input;
  if (!event || !runId || !agentId) {
    throw new Error('event, run-id, and agent-id are required');
  }
  if (!SUPPORTED_EVENTS.has(event)) {
    throw new Error(`Unsupported event: ${event}`);
  }
  if (!/^run-[a-z0-9-]+$/.test(runId)) {
    throw new Error(`Invalid run-id: ${runId}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId)) {
    throw new Error(`Invalid agent-id: ${agentId}`);
  }

  if (!claim) {
    throw new Error(`Run not found in claims: ${runId}`);
  }
  if (claim.run_id !== runId) {
    throw new Error(`Claim run_id mismatch: expected ${runId}`);
  }
  if (claim.agent_id !== agentId) {
    throw new Error(`Run ${runId} belongs to ${claim.agent_id}, not ${agentId}`);
  }

  if (event === 'run_started' && claim.state !== 'claimed') {
    throw new Error(`run_started requires claim state 'claimed' (got: ${claim.state})`);
  }
  if (EVENTS_REQUIRING_IN_PROGRESS.has(event) && claim.state !== 'in_progress') {
    throw new Error(`${event} requires run_started first (claim state must be 'in_progress', got: ${claim.state})`);
  }

  if (EVENTS_REQUIRING_PHASE.has(event) && !phase) {
    throw new Error(`Event ${event} requires --phase=<name>`);
  }
  if (EVENTS_REQUIRING_REASON.has(event) && !reason) {
    throw new Error(`Event ${event} requires --reason=<text>`);
  }
  if (event === 'run_failed' && !['requeue', 'block'].includes(policy ?? 'requeue')) {
    throw new Error(`Invalid failure policy: ${String(policy)}. Use requeue or block.`);
  }
  if (event === 'work_complete') {
    const state: FinalizationState | null = claim.finalization_state ?? null;
    if (![null, 'finalize_rebase_in_progress'].includes(state)) {
      throw new Error(`work_complete requires no finalization state or 'finalize_rebase_in_progress' (got: ${state ?? 'null'})`);
    }
  }
  if (event === 'finalize_rebase_started') {
    const state: FinalizationState | null = claim.finalization_state ?? null;
    if (state !== 'finalize_rebase_requested') {
      throw new Error(`finalize_rebase_started requires finalization_state 'finalize_rebase_requested' (got: ${state ?? 'null'})`);
    }
  }
  if (event === 'ready_to_merge' && claim.finalization_state !== 'finalize_rebase_in_progress') {
    throw new Error(`ready_to_merge requires finalization_state 'finalize_rebase_in_progress' (got: ${claim.finalization_state ?? 'null'})`);
  }

  return { claim };
}
