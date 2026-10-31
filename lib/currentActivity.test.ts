import { describe, expect, it } from 'vitest';
import {
  describeToolAction, formatActivityAge, formatActivityLine, isActivityStale, selectCurrentActivity,
} from './currentActivity.ts';
import type { RunActivitySnapshot } from './runActivityStore.ts';

const NOW = Date.parse('2026-01-01T01:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function snapshot(overrides: Partial<RunActivitySnapshot> = {}): RunActivitySnapshot {
  return {
    run_id: 'run-1', agent_id: 'orc-1', label: null, source: null, label_ts: null,
    last_tool: 'Edit', last_tool_brief: 'lib/providers.ts', last_tool_ts: ago(5),
    ...overrides,
  };
}

describe('selectCurrentActivity ranking', () => {
  it('returns null without a snapshot or any activity', () => {
    expect(selectCurrentActivity(undefined, NOW)).toBeNull();
    expect(selectCurrentActivity(snapshot({ last_tool: null, last_tool_brief: null, last_tool_ts: null }), NOW)).toBeNull();
  });

  it('prefers a fresh note over the tool call', () => {
    const s = snapshot({ label: 'Fixing findings from the critic', source: 'note', label_ts: ago(12) });
    expect(selectCurrentActivity(s, NOW)).toEqual({ text: 'Fixing findings from the critic', source: 'note', ts: ago(12) });
  });

  it('drops a note older than 5 minutes and falls back to the tool call', () => {
    const s = snapshot({ label: 'old note', source: 'note', label_ts: ago(5 * 60) });
    expect(selectCurrentActivity(s, NOW)).toEqual({ text: 'Editing lib/providers.ts', source: 'tool', ts: ago(5) });
  });

  it('prefers the to-do label over the tool call, whatever its age', () => {
    const s = snapshot({ label: 'Writing tests', source: 'todo', label_ts: ago(600) });
    expect(selectCurrentActivity(s, NOW)).toEqual({ text: 'Writing tests', source: 'todo', ts: ago(600) });
  });

  it('ignores an empty to-do label', () => {
    const s = snapshot({ label: '', source: 'todo', label_ts: ago(1) });
    expect(selectCurrentActivity(s, NOW)?.source).toBe('tool');
  });

  it('ranks note > todo > tool', () => {
    // The snapshot holds one label: a fresh note wins, a todo beats the tool, the tool is the floor.
    expect(selectCurrentActivity(snapshot({ label: 'n', source: 'note', label_ts: ago(1) }), NOW)?.source).toBe('note');
    expect(selectCurrentActivity(snapshot({ label: 't', source: 'todo', label_ts: ago(1) }), NOW)?.source).toBe('todo');
    expect(selectCurrentActivity(snapshot({ label: 'Edit: x', source: 'tool', label_ts: ago(1) }), NOW)?.source).toBe('tool');
  });
});

describe('describeToolAction', () => {
  it('renders common tools readably', () => {
    expect(describeToolAction('Edit', 'lib/providers.ts')).toBe('Editing lib/providers.ts');
    expect(describeToolAction('Bash', 'npm test')).toBe('Running npm test');
    expect(describeToolAction('Agent', 'critic')).toBe('Reviewing: critic');
    expect(describeToolAction('Agent', 'search the repo')).toBe('Delegating: search the repo');
    expect(describeToolAction('Read', '')).toBe('Reading (Read)');
    expect(describeToolAction('Mystery', 'x')).toBe('Mystery: x');
    expect(describeToolAction('Mystery', '')).toBe('Mystery');
  });
});

describe('staleness and formatting', () => {
  it('is stale from 2 minutes', () => {
    expect(isActivityStale(ago(119), NOW)).toBe(false);
    expect(isActivityStale(ago(120), NOW)).toBe(true);
  });

  it('formats ages compactly', () => {
    expect(formatActivityAge(12)).toBe('12s ago');
    expect(formatActivityAge(150)).toBe('2m ago');
    expect(formatActivityAge(7300)).toBe('2h ago');
    expect(formatActivityAge(null)).toBe('?');
  });

  it('truncates long text to the width and keeps the age', () => {
    const line = formatActivityLine({ text: 'x'.repeat(100), source: 'note', ts: ago(12) }, 32, NOW);
    expect(line.length).toBe(32);
    expect(line).toMatch(/^└ x+…   \(12s ago\)$/);
  });

  it('leaves short text whole', () => {
    expect(formatActivityLine({ text: 'Running npm test', source: 'tool', ts: ago(3) }, 60, NOW))
      .toBe('└ Running npm test   (3s ago)');
  });
});
