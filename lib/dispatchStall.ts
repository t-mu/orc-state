/** Consecutive stalled ticks before the master is told (~90 s at the 30 s tick). */
export const DISPATCH_STALL_TICKS = 3;

/** What one tick's dispatch pass saw and did. */
export interface DispatchTickOutcome {
  /** `max_workers` minus active runs, before this tick's dispatch. */
  freeSlots: number;
  /** Dispatch-ready task refs (status todo, eligible, not already claimed). */
  readyTaskRefs: string[];
  /** Runs claimed this tick whose worker launched. */
  claimed: number;
}

export interface DispatchStall {
  free_slots: number;
  ready_task_refs: string[];
  task_reasons: Record<string, string>;
  consecutive_ticks: number;
}

/**
 * Detects a dispatch stall: free capacity and ready work but no claimed run,
 * for `threshold` consecutive ticks. Reports once per stall; any tick that is
 * not stalled (a claim, no free slot, or no ready work) ends it and re-arms.
 */
export class DispatchStallDetector {
  private consecutive = 0;
  private reported = false;
  private readonly threshold: number;

  constructor(threshold = DISPATCH_STALL_TICKS) {
    this.threshold = threshold;
  }

  /** Record one tick; returns the stall to report, or null. `taskReasons` is the last known failure per task. */
  observe(outcome: DispatchTickOutcome, taskReasons: ReadonlyMap<string, string>): DispatchStall | null {
    if (outcome.freeSlots <= 0 || outcome.readyTaskRefs.length === 0 || outcome.claimed > 0) {
      this.consecutive = 0;
      this.reported = false;
      return null;
    }
    this.consecutive += 1;
    if (this.reported || this.consecutive < this.threshold) return null;
    this.reported = true;
    const reasons: Record<string, string> = {};
    for (const ref of outcome.readyTaskRefs) {
      const reason = taskReasons.get(ref);
      if (reason) reasons[ref] = reason;
    }
    return {
      free_slots: outcome.freeSlots,
      ready_task_refs: [...outcome.readyTaskRefs],
      task_reasons: reasons,
      consecutive_ticks: this.consecutive,
    };
  }
}
