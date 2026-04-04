import { describe, it, expect } from 'vitest';
import { claimedRunStartupAnchor, latestRunActivityMap, latestRunActivityDetailMap, latestRunPhaseMap, runIdleMs, runPhaseHistory } from './runActivity.ts';
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

  it('ignores coordinator-generated activity-like events', () => {
    const events = [
      { run_id: 'run-1', event: 'run_started', ts: '2026-01-01T00:00:00Z', actor_type: 'agent' },
      { run_id: 'run-1', event: 'need_input', ts: '2026-01-01T00:05:00Z', actor_type: 'coordinator' },
      { run_id: 'run-1', event: 'input_requested', ts: '2026-01-01T00:06:00Z', actor_type: 'coordinator' },
    ];
    const map = latestRunActivityMap(events as unknown as OrcEvent[]);
    expect(map.get('run-1')).toBe('2026-01-01T00:00:00Z');
  });
});

describe('latestRunActivityDetailMap', () => {
  it('tracks latest event and source metadata per run', () => {
    const events = [
      { run_id: 'run-1', event: 'run_started', ts: '2026-01-01T00:00:00Z' },
      { run_id: 'run-1', event: 'heartbeat', ts: '2026-01-01T00:01:00Z', payload: { source: 'worker-runtime-owner' } },
    ];
    const map = latestRunActivityDetailMap(events as unknown as OrcEvent[]);
    expect(map.get('run-1')).toEqual({
      ts: '2026-01-01T00:01:00Z',
      event: 'heartbeat',
      source: 'worker-runtime-owner',
    });
  });

  it('ignores coordinator-generated need_input when computing latest detail', () => {
    const events = [
      { run_id: 'run-1', event: 'run_started', ts: '2026-01-01T00:00:00Z', actor_type: 'agent' },
      { run_id: 'run-1', event: 'need_input', ts: '2026-01-01T00:01:00Z', actor_type: 'coordinator' },
    ];
    const map = latestRunActivityDetailMap(events as unknown as OrcEvent[]);
    expect(map.get('run-1')).toEqual({
      ts: '2026-01-01T00:00:00Z',
      event: 'run_started',
      source: 'run_started',
    });
  });
});

describe('latestRunPhaseMap', () => {
  it('returns last phase per run from phase_started events', () => {
    const events = [
      { run_id: 'run-1', event: 'phase_started', phase: 'explore', ts: '2026-01-01T00:00:00Z' },
      { run_id: 'run-1', event: 'phase_started', phase: 'implement', ts: '2026-01-01T00:05:00Z' },
      { run_id: 'run-2', event: 'phase_started', phase: 'review', ts: '2026-01-01T00:06:00Z' },
    ];
    const map = latestRunPhaseMap(events as OrcEvent[]);
    expect(map.get('run-1')).toBe('implement');
    expect(map.get('run-2')).toBe('review');
  });

  it('returns empty map for runs with no phase events', () => {
    const events = [
      { run_id: 'run-1', event: 'run_started', ts: '2026-01-01T00:00:00Z' },
      { run_id: 'run-1', event: 'heartbeat', ts: '2026-01-01T00:01:00Z' },
    ];
    const map = latestRunPhaseMap(events as OrcEvent[]);
    expect(map.has('run-1')).toBe(false);
  });

  it('reads phase from payload.phase when top-level phase is missing', () => {
    const events = [
      { run_id: 'run-1', event: 'phase_started', payload: { phase: 'complete' }, ts: '2026-01-01T00:00:00Z' },
    ];
    const map = latestRunPhaseMap(events as unknown as OrcEvent[]);
    expect(map.get('run-1')).toBe('complete');
  });

  it('uses latest phase when multiple phase events exist for a run', () => {
    const events = [
      { run_id: 'run-1', event: 'phase_started', phase: 'explore', ts: '2026-01-01T00:00:00Z' },
      { run_id: 'run-1', event: 'phase_started', phase: 'implement', ts: '2026-01-01T00:05:00Z' },
      { run_id: 'run-1', event: 'phase_started', phase: 'review', ts: '2026-01-01T00:10:00Z' },
    ];
    const map = latestRunPhaseMap(events as OrcEvent[]);
    expect(map.get('run-1')).toBe('review');
  });
});

describe('runIdleMs', () => {
  it('uses task_envelope_sent_at before claimed_at for claimed runs', () => {
    const now = new Date('2026-01-01T00:10:00Z').getTime();
    const claim = {
      task_envelope_sent_at: '2026-01-01T00:08:30Z',
      claimed_at: '2026-01-01T00:01:00Z',
    };
    const idle = runIdleMs(claim, null, now);
    expect(idle).toBe(90 * 1000);
  });

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

describe('runPhaseHistory', () => {
  it('returns empty map for no events', () => {
    expect(runPhaseHistory([]).size).toBe(0);
    expect(runPhaseHistory(null).size).toBe(0);
    expect(runPhaseHistory(undefined).size).toBe(0);
  });

  it('collects all phase_started events per run sorted by timestamp', () => {
    const events = [
      { run_id: 'run-1', event: 'phase_started', phase: 'implement', ts: '2026-01-01T00:05:00Z' },
      { run_id: 'run-1', event: 'phase_started', phase: 'explore', ts: '2026-01-01T00:00:00Z' },
      { run_id: 'run-1', event: 'phase_started', phase: 'review', ts: '2026-01-01T00:10:00Z' },
    ];
    const map = runPhaseHistory(events as OrcEvent[]);
    const history = map.get('run-1')!;
    expect(history).toHaveLength(3);
    expect(history[0]).toEqual({ phase: 'explore', started_at: '2026-01-01T00:00:00Z' });
    expect(history[1]).toEqual({ phase: 'implement', started_at: '2026-01-01T00:05:00Z' });
    expect(history[2]).toEqual({ phase: 'review', started_at: '2026-01-01T00:10:00Z' });
  });

  it('handles multiple runs independently', () => {
    const events = [
      { run_id: 'run-1', event: 'phase_started', phase: 'explore', ts: '2026-01-01T00:00:00Z' },
      { run_id: 'run-2', event: 'phase_started', phase: 'implement', ts: '2026-01-01T00:01:00Z' },
      { run_id: 'run-1', event: 'phase_started', phase: 'implement', ts: '2026-01-01T00:05:00Z' },
    ];
    const map = runPhaseHistory(events as OrcEvent[]);
    expect(map.get('run-1')).toHaveLength(2);
    expect(map.get('run-2')).toHaveLength(1);
    expect(map.get('run-2')![0].phase).toBe('implement');
  });

  it('ignores non-phase_started events', () => {
    const events = [
      { run_id: 'run-1', event: 'run_started', phase: 'explore', ts: '2026-01-01T00:00:00Z' },
      { run_id: 'run-1', event: 'heartbeat', ts: '2026-01-01T00:01:00Z' },
    ];
    const map = runPhaseHistory(events as OrcEvent[]);
    expect(map.has('run-1')).toBe(false);
  });

  it('reads phase from payload.phase when top-level phase is missing', () => {
    const events = [
      { run_id: 'run-1', event: 'phase_started', payload: { phase: 'complete' }, ts: '2026-01-01T00:00:00Z' },
    ];
    const map = runPhaseHistory(events as unknown as OrcEvent[]);
    expect(map.get('run-1')?.[0].phase).toBe('complete');
  });
});

describe('claimedRunStartupAnchor', () => {
  it('prefers task_envelope_sent_at when present', () => {
    expect(claimedRunStartupAnchor({
      task_envelope_sent_at: '2026-01-01T00:02:00Z',
      claimed_at: '2026-01-01T00:01:00Z',
    })).toBe('2026-01-01T00:02:00Z');
  });

  it('returns null when task_envelope_sent_at is missing', () => {
    expect(claimedRunStartupAnchor({
      task_envelope_sent_at: null,
      claimed_at: '2026-01-01T00:01:00Z',
    })).toBeNull();
  });
});
