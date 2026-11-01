import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { appendSequencedEvent, queryEvents } from './eventLog.ts';
import type { TurnEndHookEvent } from './hookEventBus.ts';
import { hookEventPathIn } from './paths.ts';
import { readClaims } from './stateReader.ts';
import type { Claim } from '../types/claims.ts';
import type { OrcEvent } from '../types/events.ts';

/**
 * Stop-hook run guard (general/stop-hook-run-guard). A Claude worker's `Stop`
 * hook (`orc stop-check`) asks the coordinator whether the session may end
 * its turn. The decision lives here, in the coordinator: a run that is still
 * being worked on, with no work-complete handoff and no pending input
 * request, blocks the stop — at most STOP_BLOCK_CAP times per run within
 * STOP_BLOCK_WINDOW_MS, and at most STOP_BLOCK_RUN_CAP times over the whole
 * run, after which the normal nudge/escalation takes over. The caps are the
 * only loop breakers: Claude's `stop_hook_active` is recorded on each
 * `stop_blocked` event for diagnosis but does not change the decision.
 */
export const STOP_BLOCK_CAP = 3;
export const STOP_BLOCK_WINDOW_MS = 10 * 60 * 1000;
/**
 * Lifetime cap: blocked turns keep a run's hook activity fresh, so without it a
 * worker that keeps trying to stop would cycle block → stop → nudge → block
 * forever without ever looking idle.
 */
export const STOP_BLOCK_RUN_CAP = 9;
/** The newest events of a run the decision reads; a run's recent history is all it needs. */
const RUN_EVENT_LIMIT = 500;

export interface StopCheckResult {
  allow: boolean;
  reason?: string;
}

export interface StopDecision extends StopCheckResult {
  /** On a block: the run's current phase and the block's number within the window. */
  phase?: string | null;
  count?: number;
}

export interface StopDecisionInput {
  runId: string;
  agentId: string;
  claim: Claim | null;
  /** The run's events, in any order. */
  events: OrcEvent[];
  nowMs: number;
}

type RunEvent = OrcEvent & { phase?: string; payload?: Record<string, unknown> };

function latest(events: RunEvent[], names: readonly string[]): RunEvent | null {
  let found: RunEvent | null = null;
  for (const event of events) {
    if (names.includes(event.event) && (!found || event.seq > found.seq)) found = event;
  }
  return found;
}

/** Phase of the run's newest `phase_started` event, or null. */
function currentPhase(events: RunEvent[]): string | null {
  const started = events.filter((event) => event.event === 'phase_started' && typeof (event.phase ?? event.payload?.phase) === 'string');
  const newest = latest(started, ['phase_started']);
  return newest ? String(newest.phase ?? newest.payload?.phase) : null;
}

/**
 * Pure decision. Claim fields are updated by the coordinator's tick, so a
 * handoff or an input request the tick has not yet processed is also read
 * from the run's events.
 */
export function decideStopCheck(input: StopDecisionInput): StopDecision {
  const { claim, runId, agentId, nowMs } = input;
  const events = input.events as RunEvent[];
  // No claim, a claim held by another agent, or a terminal claim: nothing to guard.
  if (!claim || claim.agent_id !== agentId) return { allow: true };
  if (claim.state !== 'claimed' && claim.state !== 'in_progress') return { allow: true };
  // Any finalization state follows the work-complete handoff: awaiting finalize, a requested or
  // running finalize rebase, a PR wait, or a blocked finalization.
  if (claim.finalization_state) return { allow: true };
  if (claim.input_state === 'awaiting_input') return { allow: true };

  const handoff = latest(events, ['work_complete', 'ready_to_merge']);
  const restarted = latest(events, ['run_started']);
  if (handoff && (!restarted || handoff.seq > restarted.seq)) return { allow: true };
  const requested = latest(events, ['input_requested']);
  const answered = latest(events, ['input_response']);
  if (requested && (!answered || requested.seq > answered.seq)) return { allow: true };

  const windowStart = nowMs - STOP_BLOCK_WINDOW_MS;
  const blocks = events.filter((event) => event.event === 'stop_blocked');
  const recentBlocks = blocks.filter((event) => Date.parse(event.ts) >= windowStart).length;
  // The caps end a block loop. They apply to every stop, whether Claude reports `stop_hook_active`
  // (continuing after an earlier block) or not, so a nudge-then-stop cycle cannot loop either.
  if (recentBlocks >= STOP_BLOCK_CAP || blocks.length >= STOP_BLOCK_RUN_CAP) return { allow: true };

  const phase = currentPhase(events);
  return {
    allow: false,
    reason: `Run ${runId} (phase ${phase ?? 'unknown'}) is not finished. Continue the work, or call orc run-work-complete / orc run-input-request / orc run-fail as appropriate.`,
    phase,
    count: recentBlocks + 1,
  };
}

/**
 * A Stop hook runs only once the turn is over, so no tool call is still
 * running. Append a `turn_end` record to the agent's hook-events file (the
 * file the session's own hooks append to and the coordinator tick drains), so
 * it is folded in order with the run's tool records and closes any call that
 * never reported back (lib/runActivityStore.ts). Best effort: a failed write
 * only leaves such a call open until TOOL_IN_FLIGHT_MAX_MS.
 */
export function recordTurnEnd(stateDir: string, agentId: string, nowMs: number): void {
  try {
    const file = hookEventPathIn(stateDir, agentId);
    mkdirSync(dirname(file), { recursive: true });
    const record: TurnEndHookEvent = { type: 'turn_end', ts: new Date(nowMs).toISOString() };
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    // Best effort; see above.
  }
}

/**
 * Decide for the calling worker session's run and record a block as a
 * durable `stop_blocked` event. Synchronous, so two concurrent checks in the
 * coordinator cannot both read the same block count.
 */
export function applyStopCheck(
  stateDir: string,
  { runId, agentId, stopHookActive, nowMs = Date.now() }: { runId: string; agentId: string; stopHookActive: boolean; nowMs?: number },
): StopCheckResult {
  const claim = readClaims(stateDir).claims.find((entry) => entry.run_id === runId) ?? null;
  if (claim?.agent_id === agentId && (claim.state === 'claimed' || claim.state === 'in_progress')) {
    recordTurnEnd(stateDir, agentId, nowMs);
  }
  const recent = queryEvents(stateDir, { run_id: runId, limit: RUN_EVENT_LIMIT, order: 'desc' });
  // The lifetime cap counts every block of the run, even those older than the recent-event window.
  const seen = new Set(recent.map((event) => event.seq));
  const blocks = queryEvents(stateDir, { run_id: runId, event_type: 'stop_blocked', limit: STOP_BLOCK_RUN_CAP, order: 'desc' })
    .filter((event) => !seen.has(event.seq));
  const events = [...recent, ...blocks];
  const decision = decideStopCheck({ runId, agentId, claim, events, nowMs });
  if (decision.allow) return { allow: true };
  appendSequencedEvent(stateDir, {
    ts: new Date(nowMs).toISOString(), event: 'stop_blocked', actor_type: 'coordinator', actor_id: 'coordinator',
    run_id: runId, task_ref: claim!.task_ref, agent_id: agentId,
    payload: { phase: decision.phase ?? null, count: decision.count!, stop_hook_active: stopHookActive },
  }, { lockStrategy: 'none' });
  return { allow: false, reason: decision.reason! };
}
