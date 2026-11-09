import { describe, expect, it } from 'vitest';
import {
  ALL, clampScroll, cycleOption, detailLines, featureOptions, filterTasks, statusOptions, windowStart, wrapText,
  type ProjectTaskSummary, type ProjectTaskView,
} from './taskList.ts';

function task(ref: string, status: string, extra: Partial<ProjectTaskView> = {}): ProjectTaskSummary {
  return {
    ref, title: `Title of ${ref}`, status, feature_ref: ref.split('/')[0], content_hash: 'h', spec_revision: 1, ...extra,
  } as ProjectTaskSummary;
}

const tasks = [
  task('beta/one', 'done'),
  task('alpha/two', 'todo'),
  task('alpha/three', 'blocked'),
  task('beta/four', 'todo'),
];

describe('task explorer filters', () => {
  it('offers all, then the present statuses in lifecycle order and the features sorted', () => {
    expect(statusOptions(tasks)).toEqual([ALL, 'todo', 'blocked', 'done']);
    expect(featureOptions(tasks)).toEqual([ALL, 'alpha', 'beta']);
    expect(statusOptions([])).toEqual([ALL]);
  });

  it('filters by status and feature together', () => {
    expect(filterTasks(tasks, { status: ALL, feature: ALL })).toHaveLength(4);
    expect(filterTasks(tasks, { status: 'todo', feature: ALL }).map(t => t.ref)).toEqual(['alpha/two', 'beta/four']);
    expect(filterTasks(tasks, { status: 'todo', feature: 'beta' }).map(t => t.ref)).toEqual(['beta/four']);
    expect(filterTasks(tasks, { status: 'done', feature: 'alpha' })).toEqual([]);
  });

  it('cycles options with wrap-around, restarting at the first for an unknown value', () => {
    expect(cycleOption([ALL, 'todo', 'done'], ALL)).toBe('todo');
    expect(cycleOption([ALL, 'todo', 'done'], 'done')).toBe(ALL);
    expect(cycleOption([ALL, 'todo'], 'gone')).toBe(ALL);
  });
});

describe('task explorer layout helpers', () => {
  it('wraps at spaces, hard-cuts long words and keeps blank lines', () => {
    expect(wrapText('one two three', 7)).toEqual(['one two', 'three']);
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });

  it('keeps the selection inside the list window and clamps scrolling', () => {
    expect(windowStart(0, 3, 10)).toBe(0);
    expect(windowStart(10, 20, 5)).toBe(8);
    expect(windowStart(19, 20, 5)).toBe(15);
    expect(clampScroll(-3, 50, 10)).toBe(0);
    expect(clampScroll(45, 50, 10)).toBe(40);
    expect(clampScroll(5, 3, 10)).toBe(0);
  });

  it('lays out a task detail: fields, revisions, then the spec', () => {
    const view = { ...task('alpha/two', 'todo', { priority: 'high', depends_on: ['alpha/one'], spec_revision: 2 }), body_markdown: '# Heading\n\nBody' } as ProjectTaskView;
    const lines = detailLines(view, [
      { taskRef: 'alpha/two', revision: 1, contentHash: 'a', title: 'First', metadata: {}, createdAt: '2026-11-01T00:00:00Z' },
      { taskRef: 'alpha/two', revision: 2, contentHash: 'b', title: 'Second', metadata: {}, createdAt: '2026-11-02T00:00:00Z' },
    ], 80);
    expect(lines).toContain('priority: high');
    expect(lines).toContain('depends on: alpha/one');
    expect(lines).toContain('Revisions (2)');
    expect(lines).toContain('  r2  2026-11-02T00:00:00Z  Second');
    expect(lines.slice(lines.indexOf('Spec (revision 2)') + 1)).toEqual(['# Heading', '', 'Body']);
  });
});
