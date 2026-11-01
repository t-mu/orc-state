import { describe, expect, it } from 'vitest';
import { projectActiveRuns } from './statusProjection.ts';
import { STALLED_RUN_IDLE_SECONDS } from './constants.ts';
import type { Claim } from '../types/claims.ts';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function claim(runId: string, overrides: Partial<Claim> = {}): Claim {
  return {
    run_id: runId, task_ref: 'proj/task', agent_id: 'w1', state: 'in_progress',
    claimed_at: ago(60 * 60_000), started_at: ago(59 * 60_000), last_heartbeat_at: ago(30 * 60_000), lease_expires_at: ago(-60_000),
    ...overrides,
  } as Claim;
}

describe('projectActiveRuns', () => {
  it('flags stalled runs with the shared isStalled: idle past the threshold, no input wait, no tool call running', () => {
    const rows = projectActiveRuns(
      [claim('idle'), claim('waiting', { input_state: 'awaiting_input' }), claim('testing'), claim('fresh', { last_heartbeat_at: ago(60_000) })],
      new Map(),
      NOW,
      {
        testing: {
          run_id: 'testing', agent_id: 'w1', label: null, source: null, label_ts: null,
          last_tool: null, last_tool_brief: null, last_tool_ts: null, open_tools: { toolu_1: ago(20 * 60_000) },
        },
      },
    );
    expect(Object.fromEntries(rows.map((row) => [row.run_id, row.stalled]))).toEqual({ idle: true, waiting: false, testing: false, fresh: false });
    expect(rows.find((row) => row.run_id === 'idle')?.idle_seconds).toBeGreaterThanOrEqual(STALLED_RUN_IDLE_SECONDS);
  });
});
