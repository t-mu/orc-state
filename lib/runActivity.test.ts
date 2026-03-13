import { describe, it, expect } from 'vitest';
import { latestRunActivityMap, latestRunActivityDetailMap, runIdleMs } from './runActivity.ts';
import type { OrcEvent } from '../types/index.ts';

describe('latestRunActivityMap', () => {
  it('tracks latest relevant activity per run', () => {
    const events = [
      { run_id: 'run-1', event: 'run_started', ts: '2026-01-01T00:00:00Z' },
      { run_id: 'run-1', event: 'phase_started', ts: '2026-01-01T00:01:00Z' },
      { run_id: 'run-1', event: 'work_complete', ts: '2026-01-01T00:02:00Z' },
      { run_id: 'run-2', event: 'run_started', ts: '2026-01-01T00:03:00Z' },
      { run_id: 'run-1', event: 'coordinator_started', ts: '2026-01-01T00:04:00Z' }, // ignored
    ];
    const map = latestRunActivityMap(events as OrcEvent[]);
    expect(map.get('run-1')).toBe('2026-01-01T00:02:00Z');
    expect(map.get('run-2')).toBe('2026-01-01T00:03:00Z');
  });
});

describe('latestRunActivityDetailMap', () => {
  it('tracks latest event and source metadata per run', () => {
    const events = [
      { run_id: 'run-1', event: 'run_started', ts: '2026-01-01T00:00:00Z' },
      { run_id: 'run-1', event: 'heartbeat', ts: '2026-01-01T00:01:00Z', payload: { source: 'worker-runtime-owner' } },
    ];
    const map = latestRunActivityDetailMap(events as OrcEvent[]);
    expect(map.get('run-1')).toEqual({
      ts: '2026-01-01T00:01:00Z',
      event: 'heartbeat',
      source: 'worker-runtime-owner',
    });
  });
});

describe('runIdleMs', () => {
  it('uses latest activity when provided', () => {
    const now = new Date('2026-01-01T00:10:00Z').getTime();
    const claim = { started_at: '2026-01-01T00:00:00Z' };
    const idle = runIdleMs(claim, '2026-01-01T00:08:00Z', now);
    expect(idle).toBe(2 * 60 * 1000);
  });

  it('falls back to claim started_at/claimed_at', () => {
    const now = new Date('2026-01-01T00:10:00Z').getTime();
    const claim = { started_at: '2026-01-01T00:06:00Z', claimed_at: '2026-01-01T00:05:00Z' };
    const idle = runIdleMs(claim, null, now);
    expect(idle).toBe(4 * 60 * 1000);
  });
});
