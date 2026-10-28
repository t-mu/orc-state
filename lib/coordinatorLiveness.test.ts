import { describe, expect, it } from 'vitest';
import { isCoordinatorLockHeld } from './coordinatorLiveness.ts';
import { readProcessStart } from './processIdentity.ts';

describe('isCoordinatorLockHeld', () => {
  it('holds only while the recorded process, not just its PID, is alive', () => {
    expect(isCoordinatorLockHeld({ pid: process.pid, process_start: readProcessStart(process.pid) })).toBe(true);
    expect(isCoordinatorLockHeld({ pid: process.pid, process_start: 'proc:0' })).toBe(false);
    // A lock written before process_start was recorded falls back to the PID.
    expect(isCoordinatorLockHeld({ pid: process.pid })).toBe(true);
    expect(isCoordinatorLockHeld({ pid: 'x' })).toBe(false);
    expect(isCoordinatorLockHeld(null)).toBe(false);
  });
});
