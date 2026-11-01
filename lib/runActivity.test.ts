import { describe, it, expect } from 'vitest';
import { claimedRunStartupAnchor, isLaterPhaseEvent, latestRunActivityMap, latestRunActivityDetailMap, latestRunPhaseMap, runIdleMs, runPhaseHistory, shouldRenewFromHookActivity } from './runActivity.ts';
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

describe('phase event ordering', () => {
  // An inferred phase is appended after its evidence; seq orders it, not ts.
  const events = [
    { seq: 1, run_id: 'run-1', event: 'phase_started', phase: 'explore', ts: '2026-01-01T00:00:00Z' },
    { seq: 2, run_id: 'run-1', event: 'phase_started', phase: 'review', ts: '2026-01-01T00:10:00Z' },
    { seq: 3, run_id: 'run-1', event: 'phase_started', phase: 'complete', ts: '2026-01-01T00:08:00Z',
      actor_type: 'coordinator', payload: { phase: 'complete', inferred: true, evidence_ts: '2026-01-01T00:07:00Z' } },
  ];

  it('picks the latest phase by seq', () => {
    expect(latestRunPhaseMap(events as unknown as OrcEvent[]).get('run-1')).toBe('complete');
    expect(latestRunPhaseMap([...events].reverse() as unknown as OrcEvent[]).get('run-1')).toBe('complete');
  });

  it('lists phase history in seq order', () => {
    expect(runPhaseHistory([...events].reverse() as unknown as OrcEvent[]).get('run-1')!.map((e) => e.phase))
      .toEqual(['explore', 'review', 'complete']);
  });

  it('compares seq when both sides have one, else ts', () => {
    expect(isLaterPhaseEvent(null, { seq: 1, ts: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(isLaterPhaseEvent({ seq: 2, ts: '2026-01-01T00:10:00Z' }, { seq: 3, ts: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(isLaterPhaseEvent({ seq: 3, ts: '2026-01-01T00:00:00Z' }, { seq: 2, ts: '2026-01-01T00:10:00Z' })).toBe(false);
    expect(isLaterPhaseEvent({ seq: 3, ts: '2026-01-01T00:00:00Z' }, { seq: 3, ts: '2026-01-01T00:10:00Z' })).toBe(false);
    expect(isLaterPhaseEvent({ ts: '2026-01-01T00:00:00Z' }, { seq: 1, ts: '2026-01-01T00:10:00Z' })).toBe(true);
    expect(isLaterPhaseEvent({ seq: 9, ts: '2026-01-01T00:10:00Z' }, { ts: '2026-01-01T00:00:00Z' })).toBe(false);
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

describe('shouldRenewFromHookActivity', () => {
  const LEASE = 30 * 60 * 1000;
  const NOW = Date.parse('2026-01-01T12:00:00.000Z');
  const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
  const MIN = 60 * 1000;

  it('does not renew a fresh lease on every new hook event', () => {
    const claim = { last_heartbeat_at: iso(-1 * MIN), lease_expires_at: iso(29 * MIN) };
    expect(shouldRenewFromHookActivity(claim, iso(-5000), NOW, LEASE)).toBe(false);
  });

  it('renews once the lease is half used', () => {
    const claim = { last_heartbeat_at: iso(-1 * MIN), lease_expires_at: iso(15 * MIN) };
    expect(shouldRenewFromHookActivity(claim, iso(-5000), NOW, LEASE)).toBe(true);
  });

  it('renews when the last heartbeat is half a lease old, even if the lease was extended elsewhere', () => {
    const claim = { last_heartbeat_at: iso(-15 * MIN), lease_expires_at: iso(60 * MIN) };
    expect(shouldRenewFromHookActivity(claim, iso(-5000), NOW, LEASE)).toBe(true);
  });

  it('never renews from activity that is not newer than the last heartbeat', () => {
    const claim = { last_heartbeat_at: iso(-1 * MIN), lease_expires_at: iso(1 * MIN) };
    expect(shouldRenewFromHookActivity(claim, iso(-2 * MIN), NOW, LEASE)).toBe(false);
    expect(shouldRenewFromHookActivity(claim, iso(-1 * MIN), NOW, LEASE)).toBe(false);
  });

  it('renews a claim with no heartbeat or no lease, and ignores missing or invalid activity', () => {
    expect(shouldRenewFromHookActivity({ last_heartbeat_at: null, lease_expires_at: iso(29 * MIN) }, iso(0), NOW, LEASE)).toBe(true);
    expect(shouldRenewFromHookActivity({ last_heartbeat_at: iso(-MIN), lease_expires_at: null }, iso(0), NOW, LEASE)).toBe(true);
    expect(shouldRenewFromHookActivity({ last_heartbeat_at: null }, null, NOW, LEASE)).toBe(false);
    expect(shouldRenewFromHookActivity({ last_heartbeat_at: null }, 'garbage', NOW, LEASE)).toBe(false);
    expect(shouldRenewFromHookActivity(null, iso(0), NOW, LEASE)).toBe(false);
  });
});
