import { describe, expect, it } from 'vitest';
import { DISPATCH_STALL_TICKS, DispatchStallDetector, type DispatchTickOutcome } from './dispatchStall.ts';

const stalled: DispatchTickOutcome = { freeSlots: 1, readyTaskRefs: ['app/a', 'app/b'], claimed: 0 };
const reasons = new Map([['app/a', 'injection_scan'], ['app/gone', 'dispatch_error']]);

function run(detector: DispatchStallDetector, ticks: DispatchTickOutcome[]): Array<number | null> {
  return ticks.map((tick) => detector.observe(tick, reasons)?.consecutive_ticks ?? null);
}

describe('DispatchStallDetector', () => {
  it('reports once after the threshold of stalled ticks, with slots, ready refs and their known reasons', () => {
    const detector = new DispatchStallDetector();
    expect(DISPATCH_STALL_TICKS).toBe(3);
    expect(detector.observe(stalled, reasons)).toBeNull();
    expect(detector.observe(stalled, reasons)).toBeNull();
    expect(detector.observe(stalled, reasons)).toEqual({
      free_slots: 1, ready_task_refs: ['app/a', 'app/b'], task_reasons: { 'app/a': 'injection_scan' }, consecutive_ticks: 3,
    });
    // The same stall is not repeated.
    expect(run(detector, [stalled, stalled, stalled, stalled])).toEqual([null, null, null, null]);
  });

  it('re-arms after a claim and reports a new stall', () => {
    const detector = new DispatchStallDetector(2);
    const claimed = { ...stalled, claimed: 1 };
    expect(run(detector, [stalled, stalled, stalled, claimed, stalled, stalled, stalled])).toEqual([null, 2, null, null, null, 2, null]);
  });

  it('a claim, no free slot or no ready work before the threshold resets the count', () => {
    const detector = new DispatchStallDetector(3);
    expect(run(detector, [
      stalled, stalled, { ...stalled, claimed: 1 },
      stalled, stalled, { ...stalled, freeSlots: 0 },
      stalled, stalled, { ...stalled, readyTaskRefs: [] },
      stalled, stalled, stalled,
    ])).toEqual([null, null, null, null, null, null, null, null, null, null, null, 3]);
  });
});
