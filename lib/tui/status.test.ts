import { describe, it, expect } from 'vitest';
import { buildPhases, buildWorkerSlotViewModels } from './status.ts';
import type { TuiStatus } from './status.ts';

describe('buildPhases', () => {
  it('marks completed phases as done with correct duration', () => {
    const history = [
      { phase: 'explore', started_at: '2026-01-01T00:00:00Z' },
      { phase: 'implement', started_at: '2026-01-01T00:01:12Z' },
      { phase: 'review', started_at: '2026-01-01T00:10:17Z' },
    ];
    const phases = buildPhases(history, 10, 'in_progress');
    const explore = phases.find((p) => p.name === 'explore')!;
    const implement = phases.find((p) => p.name === 'implement')!;
    const review = phases.find((p) => p.name === 'review')!;
    expect(explore.state).toBe('done');
    expect(explore.duration_seconds).toBe(72); // 1m12s
    expect(implement.state).toBe('done');
    expect(implement.duration_seconds).toBe(545); // 9m5s
    expect(review.state).toBe('active');
    expect(review.duration_seconds).toBeNull();
  });

  it('marks latest phase as active when heartbeat fresh', () => {
    const history = [
      { phase: 'explore', started_at: '2026-01-01T00:00:00Z' },
      { phase: 'implement', started_at: '2026-01-01T00:05:00Z' },
    ];
    const phases = buildPhases(history, 60, 'in_progress');
    const implement = phases.find((p) => p.name === 'implement')!;
    expect(implement.state).toBe('active');
    expect(implement.duration_seconds).toBeNull();
  });

  it('marks latest phase as stale when heartbeat > 300s', () => {
    const history = [
      { phase: 'explore', started_at: '2026-01-01T00:00:00Z' },
      { phase: 'implement', started_at: '2026-01-01T00:05:00Z' },
    ];
    const phases = buildPhases(history, 301, 'in_progress');
    const implement = phases.find((p) => p.name === 'implement')!;
    expect(implement.state).toBe('stale');
  });

  it('marks active phase as error when run_state is blocked', () => {
    const history = [
      { phase: 'explore', started_at: '2026-01-01T00:00:00Z' },
      { phase: 'implement', started_at: '2026-01-01T00:05:00Z' },
    ];
    const phases = buildPhases(history, 10, 'blocked');
    const implement = phases.find((p) => p.name === 'implement')!;
    expect(implement.state).toBe('error');
  });

  it('marks active phase as error when run_state is failed', () => {
    const history = [
      { phase: 'explore', started_at: '2026-01-01T00:00:00Z' },
    ];
    const phases = buildPhases(history, 10, 'failed');
    const explore = phases.find((p) => p.name === 'explore')!;
    expect(explore.state).toBe('error');
  });

  it('marks unstarted phases as pending', () => {
    const history = [
      { phase: 'explore', started_at: '2026-01-01T00:00:00Z' },
    ];
    const phases = buildPhases(history, 10, 'in_progress');
    const implement = phases.find((p) => p.name === 'implement')!;
    const review = phases.find((p) => p.name === 'review')!;
    const complete = phases.find((p) => p.name === 'complete')!;
    const finalize = phases.find((p) => p.name === 'finalize')!;
    expect(implement.state).toBe('pending');
    expect(review.state).toBe('pending');
    expect(complete.state).toBe('pending');
    expect(finalize.state).toBe('pending');
    expect(implement.duration_seconds).toBeNull();
  });

  it('returns all 5 canonical phases', () => {
    const history = [{ phase: 'explore', started_at: '2026-01-01T00:00:00Z' }];
    const phases = buildPhases(history, 10, 'in_progress');
    expect(phases).toHaveLength(5);
    expect(phases.map((p) => p.name)).toEqual(['explore', 'implement', 'review', 'complete', 'finalize']);
  });
});

describe('buildWorkerSlotViewModels — phases', () => {
  const baseStatus: TuiStatus = {
    worker_capacity: {
      configured_slots: 1,
      used_slots: 0,
      available_slots: 1,
      warming_slots: 0,
      unavailable_slots: 0,
      provider: 'claude',
      dispatch_ready_count: 0,
      waiting_for_capacity: 0,
      slots: [],
    },
    scout_capacity: {
      total_slots: 0,
      investigating_slots: 0,
      idle_slots: 0,
      warming_slots: 0,
      unavailable_slots: 0,
      slots: [],
    },
    tasks: { counts: {}, total: 0 },
    claims: { active: [], total: 0, awaiting_run_started: 0, in_progress: 0, stalled: 0 },
    failures: { startup: [], lifecycle: [] },
    recentEvents: [],
    eventReadError: '',
  };

  it('returns empty phases array when no run is active', () => {
    const vms = buildWorkerSlotViewModels(baseStatus);
    expect(vms[0].phases).toEqual([]);
  });

  it('builds phases from claim phase_history', () => {
    const status: TuiStatus = {
      ...baseStatus,
      claims: {
        active: [{
          run_id: 'run-1',
          task_ref: 'task/1',
          agent_id: 'orc-1',
          state: 'in_progress',
          age_seconds: 600,
          idle_seconds: 10,
          activity_seconds: 10,
          heartbeat_seconds: 30,
          current_phase: 'implement',
          phase_history: [
            { phase: 'explore', started_at: '2026-01-01T00:00:00Z' },
            { phase: 'implement', started_at: '2026-01-01T00:05:00Z' },
          ],
        }],
        total: 1,
        awaiting_run_started: 0,
        in_progress: 1,
        stalled: 0,
      },
    };
    const vms = buildWorkerSlotViewModels(status);
    expect(vms[0].phases).toHaveLength(5);
    expect(vms[0].phases[0]).toMatchObject({ name: 'explore', state: 'done' });
    expect(vms[0].phases[1]).toMatchObject({ name: 'implement', state: 'active' });
    expect(vms[0].phases[2]).toMatchObject({ name: 'review', state: 'pending' });
  });
});
