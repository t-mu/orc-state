import { describe, expect, it } from 'vitest';
import { formatBacklogRepairResult } from './backlog-sync.ts';

describe('formatBacklogRepairResult', () => {
  it('reports a no-op repair cleanly', () => {
    expect(formatBacklogRepairResult({
      updated: false,
      added_tasks: 0,
      updated_tasks: 0,
      added_features: 0,
    })).toBe('backlog sync OK: state already matched authoritative markdown specs');
  });

  it('reports repaired task and feature counts', () => {
    expect(formatBacklogRepairResult({
      updated: true,
      added_tasks: 2,
      updated_tasks: 3,
      added_features: 1,
    })).toBe([
      'backlog sync repaired orchestrator state',
      '- added features: 1',
      '- added tasks: 2',
      '- updated tasks: 3',
    ].join('\n'));
  });
});
