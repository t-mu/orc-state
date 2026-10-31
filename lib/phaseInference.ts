import type { ToolHookEvent } from './hookEventBus.ts';

/**
 * Phase inference (pure). Workers often skip `orc progress --event=phase_started`,
 * so the coordinator derives the phase from gate commands (lifecycle events)
 * and hook tool events. Inference only ever moves a run forward, and an
 * explicit phase event newer than the evidence always wins.
 */
export const PHASE_ORDER = ['explore', 'implement', 'review', 'complete', 'finalize'] as const;
export type InferablePhase = typeof PHASE_ORDER[number];

export interface PhaseCandidate {
  phase: InferablePhase;
  ts: string;
  /** Short, human-readable reason, e.g. `tool: Agent critic` or `cmd: git rebase main`. */
  evidence: string;
  /** The candidate applies only once the run has reached this phase. */
  requires?: InferablePhase;
}

export interface CurrentPhase {
  phase: string | null;
  ts: string | null;
}

/** Order of a phase name; unknown (custom) phases rank below every inferable phase. */
export function phaseRank(phase: string | null | undefined): number {
  return phase ? PHASE_ORDER.indexOf(phase as InferablePhase) : -1;
}

const REVIEWER_PATTERN = /critic|integrator|review/i;
const REVIEW_READ_PATTERN = /\breview-read\b/;
const REBASE_MAIN_PATTERN = /\bgit\b[^;&|]*\brebase\s+(?:origin\/)?main\b/;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** True when an `Agent`/`Task` tool call spawned a reviewer sub-agent. */
export function isReviewerSpawn(event: ToolHookEvent): boolean {
  if (event.tool !== 'Agent' && event.tool !== 'Task') return false;
  return REVIEWER_PATTERN.test(event.subagent_type ?? '') || REVIEWER_PATTERN.test(event.brief);
}

/** Per-run memory the tool classifier needs across ticks. */
export interface ToolPhaseState {
  /** When the run last ran `orc review-read` (the complete phase needs it before `git rebase main`). */
  review_read_at: string | null;
}

/**
 * Turn a run's newly drained tool events into phase candidates, in event order.
 * A commit is deliberately not evidence: implement commits happen too.
 */
export function toolPhaseCandidates(
  events: ToolHookEvent[],
  state: ToolPhaseState,
): { candidates: PhaseCandidate[]; state: ToolPhaseState } {
  const candidates: PhaseCandidate[] = [];
  let reviewReadAt = state.review_read_at;
  for (const event of events) {
    if (EDIT_TOOLS.has(event.tool)) {
      // A file edit after an explicit explore signal (workers often report explore after run-start).
      candidates.push({ phase: 'implement', ts: event.ts, evidence: `tool: ${event.tool}`, requires: 'explore' });
    } else if (isReviewerSpawn(event)) {
      const label = event.subagent_type || event.brief;
      candidates.push({ phase: 'review', ts: event.ts, evidence: `tool: ${event.tool} ${label}`.trim() });
    } else if (event.tool === 'Bash' && REVIEW_READ_PATTERN.test(event.brief)) {
      if (!reviewReadAt || Date.parse(event.ts) > Date.parse(reviewReadAt)) reviewReadAt = event.ts;
    } else if (event.tool === 'Bash' && REBASE_MAIN_PATTERN.test(event.brief)
      && reviewReadAt && Date.parse(reviewReadAt) <= Date.parse(event.ts)) {
      candidates.push({ phase: 'complete', ts: event.ts, evidence: `cmd: ${event.brief}`, requires: 'review' });
    }
  }
  return { candidates, state: { review_read_at: reviewReadAt } };
}

/**
 * Apply candidates in timestamp order to the run's current phase and return the
 * transitions to emit. A candidate is accepted only when it moves the run
 * forward, is not older than the current phase (an explicit phase event newer
 * than the evidence wins), and the run already reached its `requires` phase.
 */
export function inferPhaseTransitions(current: CurrentPhase, candidates: PhaseCandidate[]): PhaseCandidate[] {
  const ordered = candidates
    .filter((c) => Number.isFinite(Date.parse(c.ts)))
    .map((c, index) => ({ c, index }))
    .sort((a, b) => (Date.parse(a.c.ts) - Date.parse(b.c.ts)) || (a.index - b.index))
    .map(({ c }) => c);
  const accepted: PhaseCandidate[] = [];
  let phase = current.phase;
  let ts = current.ts;
  for (const candidate of ordered) {
    if (phaseRank(candidate.phase) <= phaseRank(phase)) continue;
    if (ts && Date.parse(candidate.ts) < Date.parse(ts)) continue;
    if (candidate.requires && phaseRank(phase) < phaseRank(candidate.requires)) continue;
    accepted.push(candidate);
    phase = candidate.phase;
    ts = candidate.ts;
  }
  return accepted;
}
