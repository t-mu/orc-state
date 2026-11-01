import { describe, it, expect } from 'vitest';
import type { ToolHookEvent } from './hookEventBus.ts';
import { inferPhaseTransitions, isReviewerSpawn, phaseInferenceClaims, phaseRank, toolPhaseCandidates, type PhaseCandidate } from './phaseInference.ts';
import type { Claim } from '../types/claims.ts';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 31, 12, minute)).toISOString();
const tool = (name: string, brief: string, minute: number, extra: Partial<ToolHookEvent> = {}): ToolHookEvent =>
  ({ type: 'tool', tool: name, brief, ts: at(minute), ...extra });
const phases = (list: PhaseCandidate[]) => list.map((c) => c.phase);

describe('phaseRank', () => {
  it('orders the inferable phases and ranks unknown phases below them', () => {
    expect(phaseRank('explore')).toBeLessThan(phaseRank('implement'));
    expect(phaseRank('review')).toBeLessThan(phaseRank('complete'));
    expect(phaseRank('complete')).toBeLessThan(phaseRank('finalize'));
    expect(phaseRank('custom')).toBe(-1);
    expect(phaseRank(null)).toBe(-1);
  });
});

describe('isReviewerSpawn', () => {
  it('recognises reviewers by sub-agent type or a review description', () => {
    expect(isReviewerSpawn(tool('Agent', 'Check the diff', 0, { subagent_type: 'critic' }))).toBe(true);
    expect(isReviewerSpawn(tool('Task', 'integrator', 0))).toBe(true);
    expect(isReviewerSpawn(tool('Agent', 'Reviewer 2 of the diff', 0))).toBe(true);
    expect(isReviewerSpawn(tool('Agent', 'Find config loaders', 0, { subagent_type: 'Explore' }))).toBe(false);
    expect(isReviewerSpawn(tool('Bash', 'critic', 0))).toBe(false);
    expect(isReviewerSpawn(tool('Agent', 'Review existing config loaders', 0, { subagent_type: 'Explore' }))).toBe(false);
    expect(isReviewerSpawn(tool('Agent', 'Preview the release notes', 0))).toBe(false);
    expect(isReviewerSpawn(tool('Agent', 'Code review of the diff', 0, { subagent_type: 'general-purpose' }))).toBe(true);
  });
});

describe('toolPhaseCandidates', () => {
  it('maps edits, reviewer spawns and review-read followed by git rebase main', () => {
    const { candidates, state } = toolPhaseCandidates([
      tool('Edit', 'lib/a.ts', 1),
      tool('Bash', 'git commit -m "feat(x): y"', 2),
      tool('Agent', 'Check the diff', 3, { subagent_type: 'critic' }),
      tool('Bash', '/home/node/.npm-global/bin/orc review-read --run-id=run-1', 4),
      tool('Bash', 'git rebase main', 5),
    ], { review_read_at: null });
    expect(candidates).toEqual([
      { phase: 'implement', ts: at(1), evidence: 'tool: Edit', requires: 'explore' },
      { phase: 'review', ts: at(3), evidence: 'tool: Agent critic' },
      { phase: 'complete', ts: at(5), evidence: 'cmd: git rebase main', requires: 'review' },
    ]);
    expect(state.review_read_at).toBe(at(4));
  });

  it('does not treat a commit as review evidence', () => {
    expect(toolPhaseCandidates([tool('Bash', 'git commit -am wip', 1)], { review_read_at: null }).candidates).toEqual([]);
  });

  it('needs a review-read before git rebase main, remembered across ticks', () => {
    expect(toolPhaseCandidates([tool('Bash', 'git rebase main', 5)], { review_read_at: null }).candidates).toEqual([]);
    expect(toolPhaseCandidates([tool('Bash', 'git rebase main', 5)], { review_read_at: at(6) }).candidates).toEqual([]);
    expect(phases(toolPhaseCandidates([tool('Bash', 'git fetch origin main && git rebase origin/main', 5)], { review_read_at: at(4) }).candidates))
      .toEqual(['complete']);
    expect(toolPhaseCandidates([tool('Bash', 'git rebase --continue', 5)], { review_read_at: at(4) }).candidates).toEqual([]);
  });
});

describe('inferPhaseTransitions', () => {
  const runFlow: PhaseCandidate[] = [
    { phase: 'explore', ts: at(0), evidence: 'event: task_envelope_sent' },
    { phase: 'implement', ts: at(1), evidence: 'event: run_started' },
    { phase: 'review', ts: at(10), evidence: 'tool: Agent critic' },
    { phase: 'complete', ts: at(20), evidence: 'cmd: git rebase main', requires: 'review' },
    { phase: 'finalize', ts: at(21), evidence: 'event: work_complete' },
  ];

  it('walks a run with no explicit phase events through every phase in order', () => {
    expect(phases(inferPhaseTransitions({ phase: null, ts: null }, [...runFlow].reverse())))
      .toEqual(['explore', 'implement', 'review', 'complete', 'finalize']);
  });

  it('never moves backwards: review fixes stay in review', () => {
    expect(inferPhaseTransitions({ phase: 'review', ts: at(10) }, [
      { phase: 'implement', ts: at(12), evidence: 'tool: Edit', requires: 'explore' },
    ])).toEqual([]);
  });

  it('lets an explicit phase event newer than the evidence win', () => {
    // The worker reported explore after run-start: run_started no longer implies implement, a later edit does.
    expect(phases(inferPhaseTransitions({ phase: 'explore', ts: at(2) }, [
      { phase: 'implement', ts: at(1), evidence: 'event: run_started' },
      { phase: 'implement', ts: at(3), evidence: 'tool: Edit', requires: 'explore' },
    ]))).toEqual(['implement']);
  });

  it('applies complete evidence only after review', () => {
    expect(inferPhaseTransitions({ phase: 'implement', ts: at(1) }, [
      { phase: 'complete', ts: at(20), evidence: 'cmd: git rebase main', requires: 'review' },
    ])).toEqual([]);
  });

  it('passes through complete and finalize on the same work_complete evidence, but only after review', () => {
    const workComplete: PhaseCandidate[] = [
      { phase: 'complete', ts: at(20), evidence: 'event: work_complete', requires: 'review' },
      { phase: 'finalize', ts: at(20), evidence: 'event: work_complete' },
    ];
    expect(phases(inferPhaseTransitions({ phase: 'review', ts: at(10) }, workComplete))).toEqual(['complete', 'finalize']);
    expect(phases(inferPhaseTransitions({ phase: 'implement', ts: at(1) }, workComplete))).toEqual(['finalize']);
  });

  it('is idempotent once the run has reached the inferred phase', () => {
    const first = inferPhaseTransitions({ phase: null, ts: null }, runFlow);
    const last = first[first.length - 1];
    expect(inferPhaseTransitions({ phase: last.phase, ts: last.ts }, runFlow)).toEqual([]);
  });
});

describe('phaseInferenceClaims', () => {
  const claim = (run_id: string, state: Claim['state']) => ({ run_id, state } as Claim);

  it('keeps the pre-batch claims of runs still active after the batch', () => {
    const before = [claim('run-active', 'in_progress'), claim('run-claimed', 'claimed')];
    const after = [claim('run-active', 'in_progress'), claim('run-claimed', 'in_progress')];
    expect(phaseInferenceClaims(before, after)).toEqual(before);
  });

  it('skips runs that finished, failed or were cancelled in the batch', () => {
    const before = [
      claim('run-done', 'in_progress'), claim('run-failed', 'in_progress'),
      claim('run-cancelled', 'in_progress'), claim('run-active', 'in_progress'),
    ];
    // A cancelled run's claim is removed from claims.json.
    const after = [claim('run-done', 'done'), claim('run-failed', 'failed'), claim('run-active', 'in_progress')];
    expect(phaseInferenceClaims(before, after).map((c) => c.run_id)).toEqual(['run-active']);
  });
});
