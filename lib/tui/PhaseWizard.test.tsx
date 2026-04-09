import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { formatDuration, PhaseWizard } from './PhaseWizard.tsx';
import type { PhaseEntry } from './status.ts';

afterEach(() => { cleanup(); });

describe('formatDuration', () => {
  it('formats seconds only', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(150)).toBe('2m 30s');
  });

  it('formats hours minutes seconds', () => {
    expect(formatDuration(3661)).toBe('1h 1m 1s');
  });

  it('drops zero hours', () => {
    expect(formatDuration(60)).toBe('1m 0s');
  });

  it('shows 0s for zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('includes minutes when hours present even if minutes are zero', () => {
    expect(formatDuration(3600)).toBe('1h 0m 0s');
  });
});

describe('PhaseWizard', () => {
  const phases: PhaseEntry[] = [
    { name: 'explore', state: 'done', duration_seconds: 72, started_at: null },
    { name: 'implement', state: 'active', duration_seconds: null, started_at: '2026-01-01T00:01:12Z' },
    { name: 'review', state: 'pending', duration_seconds: null, started_at: null },
    { name: 'complete', state: 'pending', duration_seconds: null, started_at: null },
    { name: 'finalize', state: 'pending', duration_seconds: null, started_at: null },
  ];

  it('renders all phase names', () => {
    const { lastFrame } = render(<PhaseWizard phases={phases} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('explore');
    expect(frame).toContain('implement');
    expect(frame).toContain('review');
    expect(frame).toContain('complete');
    expect(frame).toContain('finalize');
  });

  it('shows duration for done phases', () => {
    const { lastFrame } = render(<PhaseWizard phases={phases} />);
    expect(lastFrame()).toContain('1m 12s');
  });

  it('does not show duration for pending phases', () => {
    const pendingOnly: PhaseEntry[] = [
      { name: 'explore', state: 'pending', duration_seconds: null, started_at: null },
    ];
    const { lastFrame } = render(<PhaseWizard phases={pendingOnly} />);
    expect(lastFrame()).not.toContain('0s');
  });

  describe('live elapsed counter', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('shows live elapsed duration for active phase', () => {
      const now = new Date('2026-01-01T00:05:00Z').getTime();
      vi.setSystemTime(now);
      const activePhases: PhaseEntry[] = [
        { name: 'explore', state: 'done', duration_seconds: 72, started_at: null },
        { name: 'implement', state: 'active', duration_seconds: null, started_at: '2026-01-01T00:01:12Z' },
        { name: 'review', state: 'pending', duration_seconds: null, started_at: null },
      ];
      const { lastFrame } = render(<PhaseWizard phases={activePhases} />);
      const frame = lastFrame() ?? '';
      // implement started at 00:01:12, now is 00:05:00 → 228s = 3m 48s
      expect(frame).toContain('3m 48s');
    });

    it('ticks the elapsed counter each second', async () => {
      const now = new Date('2026-01-01T00:01:00Z').getTime();
      vi.setSystemTime(now);
      const activePhases: PhaseEntry[] = [
        { name: 'explore', state: 'active', duration_seconds: null, started_at: '2026-01-01T00:00:00Z' },
      ];
      const { lastFrame } = render(<PhaseWizard phases={activePhases} />);
      expect(lastFrame()).toContain('1m 0s');

      // eslint-disable-next-line @typescript-eslint/require-await -- act(async) is needed to flush React state updates with fake timers
      await act(async () => { vi.advanceTimersByTime(5000); });
      expect(lastFrame()).toContain('1m 5s');
    });

    it('shows elapsed for stale phases too', () => {
      const now = new Date('2026-01-01T00:10:00Z').getTime();
      vi.setSystemTime(now);
      const stalePhases: PhaseEntry[] = [
        { name: 'implement', state: 'stale', duration_seconds: null, started_at: '2026-01-01T00:00:00Z' },
      ];
      const { lastFrame } = render(<PhaseWizard phases={stalePhases} />);
      expect(lastFrame()).toContain('10m 0s');
    });
  });
});
