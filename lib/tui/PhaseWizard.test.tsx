import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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
    { name: 'explore', state: 'done', duration_seconds: 72 },
    { name: 'implement', state: 'active', duration_seconds: null },
    { name: 'review', state: 'pending', duration_seconds: null },
    { name: 'complete', state: 'pending', duration_seconds: null },
    { name: 'finalize', state: 'pending', duration_seconds: null },
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

  it('does not show duration for active or pending phases', () => {
    const activeOnly: PhaseEntry[] = [
      { name: 'explore', state: 'active', duration_seconds: null },
    ];
    const { lastFrame } = render(<PhaseWizard phases={activeOnly} />);
    // Should not contain duration digits followed by 's'
    expect(lastFrame()).not.toContain('0s');
  });
});
