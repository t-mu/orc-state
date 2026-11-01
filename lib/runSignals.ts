import type { Claim } from '../types/claims.ts';
import type { OrcEvent } from '../types/events.ts';
import type { DispatchedHookEvents, PermissionHookEvent, ToolHookEvent } from './hookEventBus.ts';
import { toolPhaseCandidates, type PhaseCandidate, type ToolPhaseState } from './phaseInference.ts';
import { isCommitToolEvent, isExplicitPhaseEvent, isProgressLifecycleEvent, noProgressAlertProgressAt } from './runProgress.ts';
import { claimedRunStartupAnchor, latestRunActivityMap, newestTimestamp, runIdleMs } from './runActivity.ts';
import {
  applyHookActivity, latestHookActivityTs, shouldEmitActivityNote, toolInFlight,
  type ActivityNoteState, type RunActivityMap, type RunActivitySnapshot, type RunActivitySource,
} from './runActivityStore.ts';

/**
 * Per-run activity signals, in one place.
 *
 * The coordinator owns one RunSignals: it feeds it durable events and drained
 * hook events (`ingest`), reads idle time, idle thresholds, phase candidates,
 * progress (lib/runProgress.ts: a phase change, commit or lifecycle event,
 * tracked apart from liveness) and the label to announce from it, and drops a run with `forget` once the
 * run is no longer active. `hydrate` restores what a restarted coordinator
 * needs from run-activity.json and the active runs' events.
 *
 * `isStalled` and `runIdleAnchor` are also used, without a RunSignals, by
 * `orc status`/`orc watch` (statusView), runs-active and the control API
 * (statusProjection) and the MCP `list_stalled_runs` tool, so every reader
 * agrees on when a run is stalled.
 */

/** Idle thresholds before and after a run's harness delivers tool hook events. */
export interface StaleThresholdConfig {
  /** Soft alert (worker_needs_attention reason stale) for a run without hooks. */
  softMs: number;
  /** Nudge for a run without hooks. */
  nudgeMs: number;
  /** Finalization retry nudge for a run without hooks. */
  finalizeRetryMs: number;
  /** Soft alert for a run with tool hook events (only ever shortens softMs). */
  hookIdleEscalateMs: number;
  /** Nudge and finalization retry for a run with tool hook events (only ever shortens them). */
  hookIdleNudgeMs: number;
}

export interface StaleThresholds {
  soft: number;
  nudge: number;
  finalizeRetry: number;
}

type StallClaim = Pick<Claim, 'input_state'> | { input_state?: string | null };

/**
 * The one stalled test. A run is stalled when it has been idle for at least
 * `thresholdMs`, is not waiting for an input response, and has no tool call
 * still running (a long `npm test` or sub-agent review is not idleness; an
 * unfinished call stops counting after TOOL_IN_FLIGHT_MAX_MS, or when the
 * worker's turn ends).
 */
export function isStalled(
  claim: StallClaim | null | undefined,
  idleMs: number | null | undefined,
  hookSnapshot: RunActivitySnapshot | null | undefined,
  thresholdMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (claim?.input_state === 'awaiting_input') return false;
  if (idleMs == null || !Number.isFinite(idleMs) || idleMs < thresholdMs) return false;
  return !toolInFlight(hookSnapshot, nowMs);
}

/**
 * Reader-side idle anchor (status, runs-active, control API): the newer of the
 * run's durable activity and its hook activity, then the claim's heartbeat,
 * start and startup times.
 */
export function runIdleAnchor(
  claim: Pick<Claim, 'state' | 'last_heartbeat_at' | 'started_at' | 'task_envelope_sent_at' | 'claimed_at'>,
  durableActivityTs: string | null | undefined,
  hookSnapshot: RunActivitySnapshot | null | undefined,
): string | null {
  return newestTimestamp(durableActivityTs, latestHookActivityTs(hookSnapshot))
    ?? claim.last_heartbeat_at
    ?? claim.started_at
    ?? (claim.state === 'claimed' ? claimedRunStartupAnchor(claim) : (claim.task_envelope_sent_at ?? claim.claimed_at ?? null))
    ?? null;
}

/**
 * Idle thresholds for a run: shorter once its harness has delivered tool hook
 * events, except while a tool call is still running. Hooks only ever shorten a
 * threshold, so an operator's lower setting still applies.
 */
export function staleThresholds(
  snapshot: RunActivitySnapshot | null | undefined,
  config: StaleThresholdConfig,
  nowMs: number = Date.now(),
): StaleThresholds {
  if (snapshot?.last_tool_ts && !toolInFlight(snapshot, nowMs)) {
    return {
      soft: Math.min(config.hookIdleEscalateMs, config.softMs),
      nudge: Math.min(config.hookIdleNudgeMs, config.nudgeMs),
      finalizeRetry: Math.min(config.hookIdleNudgeMs, config.finalizeRetryMs),
    };
  }
  return { soft: config.softMs, nudge: config.nudgeMs, finalizeRetry: config.finalizeRetryMs };
}

/** One run's drained hook events, as the coordinator hands them to `ingest`. */
export interface RunHookEvents extends DispatchedHookEvents {
  agentId: string;
}

/** What `ingest` changed in a run's hook activity, for lease renewal. */
export interface HookActivityChange {
  runId: string;
  previousTs: string | null;
  ts: string | null;
}

export interface IngestResult {
  /** Runs whose hook activity snapshot changed (run-activity.json needs a rewrite). */
  hookActivity: HookActivityChange[];
}

export interface CurrentActivity {
  label: string;
  source: RunActivitySource;
}

function earlier(a: string | undefined, b: string): boolean {
  return !a || Date.parse(b) < Date.parse(a);
}

function later(a: string | undefined, b: string): boolean {
  return !a || Date.parse(b) > Date.parse(a);
}

export class RunSignals {
  private readonly config: StaleThresholdConfig;
  /** Newest durable (non-coordinator) activity event per run. */
  private readonly durableActivity = new Map<string, string>();
  /** Newest phase_started per run (explicit or inferred). */
  private readonly phases = new Map<string, { phase: string; ts: string }>();
  /** Hook activity snapshots, projected to run-activity.json. */
  private readonly hookActivity: RunActivityMap = {};
  /** Permission hook events waiting for the run's input-block check. */
  private readonly pendingPermission = new Map<string, PermissionHookEvent[]>();
  /** Last announced activity_note per run. */
  private readonly notes = new Map<string, ActivityNoteState>();
  /** Phase inference evidence. */
  private readonly reviewSubmittedAt = new Map<string, string>();
  private readonly workCompleteAt = new Map<string, string>();
  private readonly toolPhaseState = new Map<string, ToolPhaseState>();
  /** Tool-derived phase candidates from the newest hook batch. */
  private readonly toolCandidates = new Map<string, PhaseCandidate[]>();
  /** Newest worker-reported (not inferred) phase per run: only its changes reset the nudge count. */
  private readonly explicitPhases = new Map<string, { phase: string; ts: string }>();
  /** Newest progress point per run, and the progress point a no-progress alert was sent for. */
  private readonly lastProgressAt = new Map<string, string>();
  private readonly noProgressNotified = new Map<string, string>();

  constructor(config: StaleThresholdConfig) {
    this.config = config;
  }

  /**
   * Restore state after a coordinator restart: hook snapshots from
   * run-activity.json (a persisted label counts as already announced at its
   * label time, so it is not re-announced) and the active runs' events.
   */
  hydrate(activity: RunActivityMap, events: OrcEvent[] = [], nowMs: number = Date.now()): void {
    for (const [runId, snapshot] of Object.entries(activity)) {
      this.hookActivity[runId] = snapshot;
      if (snapshot.label && !this.notes.has(runId)) {
        const labelMs = Date.parse(snapshot.label_ts ?? '');
        this.notes.set(runId, { label: snapshot.label, emitted_at_ms: Number.isFinite(labelMs) ? labelMs : nowMs });
      }
    }
    this.ingest(events, undefined, nowMs);
  }

  /**
   * Fold durable events and, when given, one tick's drained hook events into
   * the per-run state. A hook batch replaces the runs' tool-derived phase
   * candidates; runs absent from it have none this tick.
   */
  ingest(events: OrcEvent[], hookEvents?: Map<string, RunHookEvents>, nowMs: number = Date.now()): IngestResult {
    for (const [runId, ts] of latestRunActivityMap(events)) {
      if (later(this.durableActivity.get(runId), ts)) this.durableActivity.set(runId, ts);
    }
    for (const event of events) {
      const runId = (event as { run_id?: string }).run_id;
      if (!runId) continue;
      if (isProgressLifecycleEvent(event)) this.noteProgress(runId, event.ts, nowMs);
      // Replayed after a restart: the progress point an alert was already sent for.
      const alertedFor = noProgressAlertProgressAt(event);
      if (alertedFor) this.noProgressNotified.set(runId, alertedFor);
      if (event.event === 'review_submitted' && earlier(this.reviewSubmittedAt.get(runId), event.ts)) {
        this.reviewSubmittedAt.set(runId, event.ts);
      }
      if (event.event === 'work_complete' && later(this.workCompleteAt.get(runId), event.ts)) {
        this.workCompleteAt.set(runId, event.ts);
      }
      if (event.event === 'phase_started') {
        const phase = (event as { phase?: unknown }).phase ?? (event as { payload?: { phase?: unknown } }).payload?.phase;
        if (typeof phase === 'string' && phase.length > 0) {
          if (isExplicitPhaseEvent(event) && later(this.explicitPhases.get(runId)?.ts, event.ts)) {
            this.explicitPhases.set(runId, { phase, ts: event.ts });
          }
          this.recordPhase(runId, phase, event.ts, nowMs);
        }
      }
    }

    const changes: HookActivityChange[] = [];
    if (!hookEvents) return { hookActivity: changes };
    this.toolCandidates.clear();
    for (const [runId, { agentId, permission, activity }] of hookEvents) {
      if (permission.length > 0) {
        this.pendingPermission.set(runId, [...(this.pendingPermission.get(runId) ?? []), ...permission]);
      }
      const tools = activity.filter((event): event is ToolHookEvent => event.type === 'tool');
      for (const tool of tools) {
        if (isCommitToolEvent(tool)) this.noteProgress(runId, tool.ts, nowMs);
      }
      if (tools.length > 0) {
        const result = toolPhaseCandidates(tools, this.toolPhaseState.get(runId) ?? { review_read_at: null });
        this.toolPhaseState.set(runId, result.state);
        this.toolCandidates.set(runId, result.candidates);
      }
      if (activity.length > 0) {
        const previousTs = latestHookActivityTs(this.hookActivity[runId]);
        this.hookActivity[runId] = applyHookActivity(this.hookActivity[runId], runId, agentId, activity, nowMs);
        changes.push({ runId, previousTs, ts: latestHookActivityTs(this.hookActivity[runId]) });
      }
    }
    return { hookActivity: changes };
  }

  /**
   * Record a phase the coordinator inferred (or any phase_started) if it is the
   * run's newest. A change of phase is progress.
   */
  recordPhase(runId: string, phase: string, ts: string, nowMs: number = Date.now()): void {
    const current = this.phases.get(runId);
    if (!later(current?.ts, ts)) return;
    if (current?.phase !== phase) this.noteProgress(runId, ts, nowMs);
    this.phases.set(runId, { phase, ts });
  }

  /** Record progress at `ts`, clamped to now: worker timestamps are not trusted to be in the past. */
  private noteProgress(runId: string, ts: string, nowMs: number): void {
    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs)) return;
    const at = new Date(Math.min(tsMs, nowMs)).toISOString();
    if (later(this.lastProgressAt.get(runId), at)) this.lastProgressAt.set(runId, at);
  }

  /** The run's newest progress point, or null. */
  progressAt(runId: string): string | null {
    return this.lastProgressAt.get(runId) ?? null;
  }

  /** The progress point a no-progress alert was already sent for, or null. */
  noProgressNotifiedFor(runId: string): string | null {
    return this.noProgressNotified.get(runId) ?? null;
  }

  markNoProgressNotified(runId: string, progressAt: string): void {
    this.noProgressNotified.set(runId, progressAt);
  }

  /** The run's newest worker-reported phase, or null. */
  explicitPhase(runId: string): string | null {
    return this.explicitPhases.get(runId)?.phase ?? null;
  }

  /** The run's newest phase and its time. */
  currentPhase(runId: string): { phase: string | null; ts: string | null } {
    const current = this.phases.get(runId);
    return { phase: current?.phase ?? null, ts: current?.ts ?? null };
  }

  /** The run's hook activity snapshot. */
  hookSnapshot(runId: string): RunActivitySnapshot | undefined {
    return this.hookActivity[runId];
  }

  /** Every hook snapshot, as written to run-activity.json. */
  hookActivityMap(): RunActivityMap {
    return this.hookActivity;
  }

  /** Coordinator idle time: from the newer of durable and hook activity, then the claim's own times. */
  idleMs(claim: Claim, nowMs: number = Date.now()): number | null {
    return runIdleMs(claim, newestTimestamp(this.durableActivity.get(claim.run_id), latestHookActivityTs(this.hookActivity[claim.run_id])), nowMs);
  }

  thresholds(runId: string, nowMs: number = Date.now()): StaleThresholds {
    return staleThresholds(this.hookActivity[runId], this.config, nowMs);
  }

  isStalled(claim: Claim, idleMs: number | null, thresholdMs: number, nowMs: number = Date.now()): boolean {
    return isStalled(claim, idleMs, this.hookActivity[claim.run_id], thresholdMs, nowMs);
  }

  /**
   * Phase evidence for an active run: the claim's own envelope and start
   * times, review_submitted, work_complete, and the newest hook batch's tool
   * candidates. Timestamps are clamped to `nowMs`.
   */
  phaseCandidates(claim: Claim, nowMs: number = Date.now()): PhaseCandidate[] {
    const candidates: PhaseCandidate[] = [];
    if (claim.task_envelope_sent_at) candidates.push({ phase: 'explore', ts: claim.task_envelope_sent_at, evidence: 'event: task_envelope_sent' });
    if (claim.started_at) candidates.push({ phase: 'implement', ts: claim.started_at, evidence: 'event: run_started' });
    const reviewAt = this.reviewSubmittedAt.get(claim.run_id);
    if (reviewAt) candidates.push({ phase: 'review', ts: reviewAt, evidence: 'event: review_submitted' });
    const workCompleteAt = this.workCompleteAt.get(claim.run_id);
    if (workCompleteAt) {
      // A reviewed run that never showed a detectable rebase (PR mode skips it) still passes through complete.
      candidates.push({ phase: 'complete', ts: workCompleteAt, evidence: 'event: work_complete', requires: 'review' });
      candidates.push({ phase: 'finalize', ts: workCompleteAt, evidence: 'event: work_complete' });
    }
    candidates.push(...(this.toolCandidates.get(claim.run_id) ?? []));
    return candidates.map((candidate) => ({ ...candidate, ts: new Date(Math.min(Date.parse(candidate.ts), nowMs)).toISOString() }));
  }

  /**
   * The run's label when it should be announced as an `activity_note`: a todo
   * or note label (tool labels stay in run-activity.json) that differs from the
   * last announced one, throttled. Null otherwise.
   */
  currentActivity(runId: string, nowMs: number = Date.now()): CurrentActivity | null {
    const snapshot = this.hookActivity[runId];
    if (!snapshot?.label || !snapshot.source || snapshot.source === 'tool') return null;
    if (!shouldEmitActivityNote(this.notes.get(runId), snapshot.label, nowMs)) return null;
    return { label: snapshot.label, source: snapshot.source };
  }

  /** Record that the run's label was announced. */
  markActivityAnnounced(runId: string, label: string, nowMs: number = Date.now()): void {
    this.notes.set(runId, { label, emitted_at_ms: nowMs });
  }

  /** Take (and clear) the run's pending permission hook events. */
  takePermission(runId: string): PermissionHookEvent[] {
    const events = this.pendingPermission.get(runId) ?? [];
    this.pendingPermission.delete(runId);
    return events;
  }

  /** Drop everything known about a run. Returns true when it had a hook snapshot. */
  forget(runId: string): boolean {
    const hadSnapshot = runId in this.hookActivity;
    delete this.hookActivity[runId];
    for (const map of [
      this.durableActivity, this.phases, this.pendingPermission, this.notes,
      this.reviewSubmittedAt, this.workCompleteAt, this.toolPhaseState, this.toolCandidates,
      this.explicitPhases, this.lastProgressAt, this.noProgressNotified,
    ] as Array<Map<string, unknown>>) {
      map.delete(runId);
    }
    return hadSnapshot;
  }

  /** Every run this instance holds state for. */
  knownRuns(): Set<string> {
    return new Set([
      ...Object.keys(this.hookActivity), ...this.durableActivity.keys(), ...this.phases.keys(),
      ...this.pendingPermission.keys(), ...this.notes.keys(), ...this.reviewSubmittedAt.keys(),
      ...this.workCompleteAt.keys(), ...this.toolPhaseState.keys(), ...this.toolCandidates.keys(),
      ...this.explicitPhases.keys(), ...this.lastProgressAt.keys(), ...this.noProgressNotified.keys(),
    ]);
  }
}
