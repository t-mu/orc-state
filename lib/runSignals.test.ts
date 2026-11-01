import { describe, expect, it } from 'vitest';
import { RunSignals, isStalled, runIdleAnchor, staleThresholds, type RunHookEvents, type StaleThresholdConfig } from './runSignals.ts';
import { TOOL_IN_FLIGHT_MAX_MS, type RunActivitySnapshot } from './runActivityStore.ts';
import type { Claim } from '../types/claims.ts';
import type { OrcEvent } from '../types/events.ts';

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const MIN = 60_000;

const CONFIG: StaleThresholdConfig = {
  softMs: 30 * MIN, nudgeMs: 60 * MIN, finalizeRetryMs: 20 * MIN, hookIdleEscalateMs: 10 * MIN, hookIdleNudgeMs: 5 * MIN,
};

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    run_id: 'run-1', task_ref: 'proj/task', agent_id: 'w1', state: 'in_progress',
    claimed_at: at(-120 * MIN), started_at: at(-110 * MIN), lease_expires_at: at(60 * MIN), ...overrides,
  } as Claim;
}

function event(name: string, extra: Record<string, unknown> = {}): OrcEvent {
  return { seq: 1, event: name, actor_type: 'agent', actor_id: 'w1', run_id: 'run-1', task_ref: 'proj/task', agent_id: 'w1', ...extra } as unknown as OrcEvent;
}

function hooks(runId: string, activity: RunHookEvents['activity'], permission: RunHookEvents['permission'] = []): Map<string, RunHookEvents> {
  return new Map([[runId, { agentId: 'w1', activity, permission }]]);
}

function snapshot(overrides: Partial<RunActivitySnapshot> = {}): RunActivitySnapshot {
  return {
    run_id: 'run-1', agent_id: 'w1', label: null, source: null, label_ts: null,
    last_tool: null, last_tool_brief: null, last_tool_ts: null, ...overrides,
  };
}

describe('isStalled', () => {
  it('is true only past the threshold, without an input wait or a running tool call', () => {
    expect(isStalled(claim(), 11 * MIN, undefined, 10 * MIN, T0)).toBe(true);
    expect(isStalled(claim(), 9 * MIN, undefined, 10 * MIN, T0)).toBe(false);
    expect(isStalled(claim(), null, undefined, 10 * MIN, T0)).toBe(false);
    expect(isStalled(claim(), Number.NaN, undefined, 10 * MIN, T0)).toBe(false);
    expect(isStalled(claim({ input_state: 'awaiting_input' }), 11 * MIN, undefined, 10 * MIN, T0)).toBe(false);
    expect(isStalled(claim(), 11 * MIN, snapshot({ open_tools: { a: at(-11 * MIN) } }), 10 * MIN, T0)).toBe(false);
  });

  it('stops honouring an unfinished tool call after TOOL_IN_FLIGHT_MAX_MS', () => {
    const stale = snapshot({ open_tools: { a: at(-TOOL_IN_FLIGHT_MAX_MS - 1) } });
    expect(isStalled(claim(), TOOL_IN_FLIGHT_MAX_MS, stale, 10 * MIN, T0)).toBe(true);
  });
});

describe('staleThresholds', () => {
  it('uses the long thresholds without hooks or with a tool call running, the hook ones otherwise', () => {
    expect(staleThresholds(undefined, CONFIG, T0)).toEqual({ soft: 30 * MIN, nudge: 60 * MIN, finalizeRetry: 20 * MIN });
    const hooked = snapshot({ last_tool_ts: at(-MIN) });
    expect(staleThresholds(hooked, CONFIG, T0)).toEqual({ soft: 10 * MIN, nudge: 5 * MIN, finalizeRetry: 5 * MIN });
    expect(staleThresholds({ ...hooked, open_tools: { a: at(-MIN) } }, CONFIG, T0)).toEqual({ soft: 30 * MIN, nudge: 60 * MIN, finalizeRetry: 20 * MIN });
  });

  it('only ever shortens an operator setting', () => {
    const low = { ...CONFIG, softMs: 2 * MIN, nudgeMs: 3 * MIN, finalizeRetryMs: MIN };
    expect(staleThresholds(snapshot({ last_tool_ts: at(-MIN) }), low, T0)).toEqual({ soft: 2 * MIN, nudge: 3 * MIN, finalizeRetry: MIN });
  });
});

describe('runIdleAnchor', () => {
  it('takes the newer of durable and hook activity, then the claim times', () => {
    const hooked = snapshot({ last_tool_ts: at(-2 * MIN) });
    expect(runIdleAnchor(claim(), at(-5 * MIN), hooked)).toBe(at(-2 * MIN));
    expect(runIdleAnchor(claim(), at(-1 * MIN), hooked)).toBe(at(-1 * MIN));
    expect(runIdleAnchor(claim({ last_heartbeat_at: at(-3 * MIN) }), null, undefined)).toBe(at(-3 * MIN));
    expect(runIdleAnchor(claim({ state: 'claimed', started_at: null, task_envelope_sent_at: at(-4 * MIN) }), null, undefined)).toBe(at(-4 * MIN));
  });
});

describe('RunSignals', () => {
  it('measures idle time from durable and hook activity and keeps the newest of each', () => {
    const signals = new RunSignals(CONFIG);
    signals.ingest([event('heartbeat', { ts: at(-20 * MIN) }), event('heartbeat', { ts: at(-30 * MIN) })]);
    expect(signals.idleMs(claim(), T0)).toBe(20 * MIN);
    // Coordinator-authored events are not worker activity.
    signals.ingest([event('heartbeat', { ts: at(-MIN), actor_type: 'coordinator' })]);
    expect(signals.idleMs(claim(), T0)).toBe(20 * MIN);
    const { hookActivity } = signals.ingest([], hooks('run-1', [{ type: 'tool', tool: 'Bash', brief: 'ls', ts: at(-3 * MIN) }]), T0);
    expect(hookActivity).toEqual([{ runId: 'run-1', previousTs: null, ts: at(-3 * MIN) }]);
    expect(signals.idleMs(claim(), T0)).toBe(3 * MIN);
    expect(signals.thresholds('run-1', T0).nudge).toBe(5 * MIN);
    expect(signals.isStalled(claim(), 6 * MIN, 5 * MIN, T0)).toBe(true);
  });

  it('a turn_end clears open tool calls so the run is stallable again', () => {
    const signals = new RunSignals(CONFIG);
    signals.ingest([], hooks('run-1', [
      { type: 'tool', tool: 'Edit', brief: 'a.ts', id: 'a', ts: at(-12 * MIN) },
      { type: 'tool_start', tool: 'Bash', id: 'refused', ts: at(-11 * MIN) },
    ]), T0);
    expect(signals.isStalled(claim(), 11 * MIN, 10 * MIN, T0)).toBe(false);
    expect(signals.thresholds('run-1', T0).soft).toBe(30 * MIN);
    signals.ingest([], hooks('run-1', [{ type: 'turn_end', ts: at(-10 * MIN) }]), T0);
    expect(signals.hookSnapshot('run-1')?.open_tools).toBeUndefined();
    expect(signals.thresholds('run-1', T0).soft).toBe(10 * MIN);
    expect(signals.isStalled(claim(), 11 * MIN, 10 * MIN, T0)).toBe(true);
  });

  it('builds phase candidates from the claim, review/work-complete events and this batch\'s tool calls', () => {
    const signals = new RunSignals(CONFIG);
    signals.ingest([
      event('review_submitted', { ts: at(-8 * MIN) }),
      event('review_submitted', { ts: at(-9 * MIN) }),
      event('work_complete', { ts: at(-2 * MIN) }),
      event('work_complete', { ts: at(-1 * MIN) }),
    ]);
    signals.ingest([], hooks('run-1', [{ type: 'tool', tool: 'Edit', brief: 'a.ts', ts: at(-3 * MIN) }]), T0);
    const c = claim({ task_envelope_sent_at: at(-115 * MIN), started_at: at(5 * MIN) });
    const candidates = signals.phaseCandidates(c, T0);
    expect(candidates.find((x) => x.phase === 'explore')?.ts).toBe(at(-115 * MIN));
    // Future timestamps are clamped to now.
    expect(candidates.find((x) => x.phase === 'implement')?.ts).toBe(at(0));
    expect(candidates.find((x) => x.phase === 'review')?.ts).toBe(at(-9 * MIN)); // first review
    expect(candidates.filter((x) => x.phase === 'finalize').map((x) => x.ts)).toEqual([at(-MIN)]); // last work_complete
    expect(candidates.some((x) => x.evidence === 'tool: Edit')).toBe(true);
    // The next hook batch without tool calls carries no tool candidates.
    signals.ingest([], new Map(), T0);
    expect(signals.phaseCandidates(c, T0).some((x) => x.evidence === 'tool: Edit')).toBe(false);
  });

  it('tracks the newest phase from events and recorded inferences', () => {
    const signals = new RunSignals(CONFIG);
    signals.ingest([event('phase_started', { ts: at(-5 * MIN), phase: 'implement' }), event('phase_started', { ts: at(-6 * MIN), payload: { phase: 'explore' } })]);
    expect(signals.currentPhase('run-1')).toEqual({ phase: 'implement', ts: at(-5 * MIN) });
    signals.recordPhase('run-1', 'review', at(-MIN));
    expect(signals.phaseMap().get('run-1')).toBe('review');
    expect(signals.currentPhase('other')).toEqual({ phase: null, ts: null });
  });

  it('hands out pending permission events once', () => {
    const signals = new RunSignals(CONFIG);
    signals.ingest([], hooks('run-1', [], [{ type: 'permission', message: 'Allow?', ts: at(0) }]), T0);
    signals.ingest([], hooks('run-1', [], [{ type: 'permission', message: 'Again?', ts: at(1) }]), T0);
    expect(signals.takePermission('run-1').map((e) => e.message)).toEqual(['Allow?', 'Again?']);
    expect(signals.takePermission('run-1')).toEqual([]);
  });

  it('announces a todo/note label once, throttled, and never a tool label', () => {
    const signals = new RunSignals(CONFIG);
    signals.ingest([], hooks('run-1', [{ type: 'tool', tool: 'Bash', brief: 'ls', ts: at(0) }]), T0);
    expect(signals.currentActivity('run-1', T0)).toBeNull();
    signals.ingest([], hooks('run-1', [{ type: 'activity', label: 'Writing tests', source: 'todo', ts: at(1000) }]), T0 + 1000);
    expect(signals.currentActivity('run-1', T0 + 1000)).toEqual({ label: 'Writing tests', source: 'todo' });
    signals.markActivityAnnounced('run-1', 'Writing tests', T0 + 1000);
    expect(signals.currentActivity('run-1', T0 + 2000)).toBeNull();
  });

  it('hydrates from run-activity.json without re-announcing persisted labels, and replays events', () => {
    const signals = new RunSignals(CONFIG);
    signals.hydrate(
      { 'run-1': snapshot({ label: 'Reviewing', source: 'note', label_ts: at(-MIN), last_tool_ts: at(-2 * MIN) }) },
      [event('review_submitted', { ts: at(-3 * MIN) })],
      T0,
    );
    expect(signals.hookSnapshot('run-1')?.label).toBe('Reviewing');
    expect(signals.currentActivity('run-1', T0)).toBeNull();
    expect(signals.phaseCandidates(claim({ started_at: null }), T0).map((c) => c.phase)).toEqual(['review']);
    expect(signals.idleMs(claim(), T0)).toBe(MIN);
  });

  it('forget drops every per-run signal and reports whether a hook snapshot went', () => {
    const signals = new RunSignals(CONFIG);
    signals.ingest([event('review_submitted', { ts: at(-MIN) }), event('phase_started', { ts: at(-MIN), phase: 'review' })]);
    signals.ingest([], hooks('run-1', [{ type: 'tool', tool: 'Bash', brief: 'ls', ts: at(0) }], [{ type: 'permission', message: 'x', ts: at(0) }]), T0);
    expect(signals.knownRuns()).toEqual(new Set(['run-1']));
    expect(signals.forget('run-1')).toBe(true);
    expect(signals.knownRuns()).toEqual(new Set());
    expect(signals.hookActivityMap()).toEqual({});
    expect(signals.takePermission('run-1')).toEqual([]);
    expect(signals.currentPhase('run-1').phase).toBeNull();
    expect(signals.forget('run-1')).toBe(false);
  });
});
