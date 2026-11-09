import { queryEvents } from './eventLog.ts';
import type { Claim } from '../types/claims.ts';

export interface WaitingInputRow {
  run_id: string;
  agent_id: string;
  task_ref: string;
  question: string | null;
  request_id: string | null;
  waiting_seconds: number | null;
  input_requested_at: string | null;
}

/**
 * Claims in `awaiting_input` with the question from each run's latest
 * `input_requested` event. Shared by `orc waiting-input` and the status view.
 * An unreadable event log leaves the questions null; the claims stay usable.
 */
export function listWaitingInput(stateDir: string, claims: Claim[], now = Date.now()): WaitingInputRow[] {
  return claims.filter((c) => c.input_state === 'awaiting_input').map((c) => {
    let question: string | null = null;
    let ts: string | null = null;
    let requestId: string | null = null;
    try {
      const [ev] = queryEvents(stateDir, { run_id: c.run_id, event_type: 'input_requested', order: 'desc', limit: 1 });
      const e = ev as unknown as { ts?: unknown; payload?: { question?: unknown; request_id?: unknown } } | undefined;
      if (typeof e?.payload?.question === 'string') question = e.payload.question;
      if (typeof e?.payload?.request_id === 'string') requestId = e.payload.request_id;
      if (typeof e?.ts === 'string') ts = e.ts;
    } catch {
      // ignore event read errors — claims data is still usable
    }
    return {
      run_id: c.run_id,
      agent_id: c.agent_id,
      task_ref: c.task_ref,
      question,
      request_id: requestId,
      waiting_seconds: ts ? Math.round((now - new Date(ts).getTime()) / 1000) : null,
      input_requested_at: ts,
    };
  });
}
