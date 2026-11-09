import { join } from 'node:path';
import { readEventsForRuns } from './eventLog.ts';
import { latestRunActivityDetailMap, latestRunPhaseMap } from './runActivity.ts';
import { readRunActivity } from './runActivityStore.ts';
import { projectActiveRuns } from './statusProjection.ts';
import { STALLED_RUN_IDLE_SECONDS } from './constants.ts';
import { readClaims } from './stateReader.ts';
import { listWaitingInput } from './waitingInput.ts';
import type { OrcEvent } from '../types/events.ts';

export const RUN_LIST_STATES = ['active', 'stalled', 'waiting_input'] as const;
export type RunListState = typeof RUN_LIST_STATES[number];

export interface RunListRow {
  run_id: string;
  task_ref: string;
  agent_id: string;
  /** Claim state: `claimed` or `in_progress`. */
  state: string;
  phase: string | null;
  age_seconds: number | null;
  idle_seconds: number | null;
  stalled: boolean;
  /** Present only on runs waiting for an input response. */
  question?: string | null;
  request_id?: string | null;
  waiting_seconds?: number | null;
}

export interface RunListArgs {
  state?: unknown;
  stale_after_ms?: unknown;
  now_ms?: unknown;
}

/**
 * The one run listing behind MCP `list_runs`, `orc runs --json` and the
 * control API `GET /v1/runs`. Only live runs (claimed / in_progress) appear;
 * a finished claim that still carries `awaiting_input` (legacy runs) is never
 * listed as waiting (lib/waitingInput.ts). `stale_after_ms` (default
 * STALLED_RUN_IDLE_SECONDS) sets the idle threshold behind `stalled`.
 */
export function listRuns(stateDir: string, { state = 'active', stale_after_ms, now_ms }: RunListArgs = {}): { runs: RunListRow[] } {
  if (!RUN_LIST_STATES.includes(state as RunListState)) {
    throw new Error(`state must be one of ${RUN_LIST_STATES.join(', ')}`);
  }
  const staleAfterMs = stale_after_ms ?? STALLED_RUN_IDLE_SECONDS * 1000;
  if (!Number.isSafeInteger(staleAfterMs) || (staleAfterMs as number) < 0) {
    throw new Error('stale_after_ms must be a non-negative integer');
  }
  const now = typeof now_ms === 'number' ? now_ms : Date.now();
  const claims = readClaims(stateDir).claims;
  const live = claims.filter((c) => c.state === 'claimed' || c.state === 'in_progress');
  const events = readLiveRunEvents(stateDir, live.map((c) => c.run_id));
  const activity = latestRunActivityDetailMap(events);
  const phases = latestRunPhaseMap(events);
  const waiting = new Map(listWaitingInput(stateDir, live, now).map((row) => [row.run_id, row]));

  const rows = projectActiveRuns(live, activity, now, readRunActivity(stateDir), staleAfterMs as number).map((run): RunListRow => {
    const wait = waiting.get(run.run_id);
    return {
      run_id: run.run_id,
      task_ref: run.task_ref,
      agent_id: run.agent_id,
      state: run.state,
      phase: phases.get(run.run_id) ?? null,
      age_seconds: run.age_seconds,
      idle_seconds: run.idle_seconds,
      stalled: run.stalled,
      ...(wait ? { question: wait.question, request_id: wait.request_id, waiting_seconds: wait.waiting_seconds } : {}),
    };
  });
  if (state === 'stalled') return { runs: rows.filter((row) => row.stalled) };
  if (state === 'waiting_input') return { runs: rows.filter((row) => waiting.has(row.run_id)) };
  return { runs: rows };
}

/** Activity and phase events of the live runs; an unreadable log leaves them empty (the claims stay usable). */
function readLiveRunEvents(stateDir: string, runIds: string[]): OrcEvent[] {
  try {
    return readEventsForRuns(join(stateDir, 'events.db'), runIds);
  } catch {
    return [];
  }
}
