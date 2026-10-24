import { describe, expect, it } from 'vitest';
import { canTransitionTaskStatus, deriveDependencyReadiness, selectProject } from './projectContract.ts';

const projects = [
  { id: 'project-a', canonicalGitRoot: '/repos/a' },
  { id: 'project-b', canonicalGitRoot: '/repos/b' },
];

describe('project selection contract', () => {
  it('prefers explicit id, then environment, then the current Git root', () => {
    expect(selectProject({ projects, explicitProjectId: 'project-b', environmentProjectId: 'project-a', cwdGitRoot: '/repos/a' }))
      .toEqual({ projectId: 'project-b', source: 'explicit' });
    expect(selectProject({ projects, environmentProjectId: 'project-b', cwdGitRoot: '/repos/a' }))
      .toEqual({ projectId: 'project-b', source: 'environment' });
    expect(selectProject({ projects, cwdGitRoot: '/repos/a', selectedProjectId: 'project-b' }))
      .toEqual({ projectId: 'project-a', source: 'cwd' });
  });

  it('uses the selected project only outside a Git repo', () => {
    expect(selectProject({ projects, selectedProjectId: 'project-b' }))
      .toEqual({ projectId: 'project-b', source: 'selected' });
    expect(() => selectProject({ projects, cwdGitRoot: '/repos/unregistered', selectedProjectId: 'project-b' }))
      .toThrow('not registered');
  });

  it('fails closed for unknown, empty, and ambiguous selections', () => {
    expect(() => selectProject({ projects, explicitProjectId: 'missing', cwdGitRoot: '/repos/a' })).toThrow('not uniquely registered');
    expect(() => selectProject({ projects, environmentProjectId: '' })).toThrow('Empty environment');
    expect(() => selectProject({ projects: [...projects, { id: 'project-c', canonicalGitRoot: '/repos/a' }], cwdGitRoot: '/repos/a' }))
      .toThrow('multiple projects');
    expect(() => selectProject({ projects })).toThrow('No project selected');
  });
});

describe('task lifecycle contract', () => {
  it('allows the claim, start, merge, and release sequence', () => {
    expect(canTransitionTaskStatus('todo', 'claimed', 'claim')).toBe(true);
    expect(canTransitionTaskStatus('claimed', 'in_progress', 'run_start')).toBe(true);
    expect(canTransitionTaskStatus('in_progress', 'done', 'merge_succeeded')).toBe(true);
    expect(canTransitionTaskStatus('done', 'released', 'post_merge_release')).toBe(true);
  });

  it('does not complete work before merge or reopen completed work without an operator reset', () => {
    expect(canTransitionTaskStatus('in_progress', 'done', 'run_start')).toBe(false);
    expect(canTransitionTaskStatus('done', 'todo', 'failure_requeue')).toBe(false);
    expect(canTransitionTaskStatus('released', 'todo', 'operator_reset')).toBe(true);
  });

  it('keeps blocking, unblocking, and failure policy explicit', () => {
    expect(canTransitionTaskStatus('todo', 'blocked', 'manual_block')).toBe(true);
    expect(canTransitionTaskStatus('blocked', 'todo', 'unblock')).toBe(true);
    expect(canTransitionTaskStatus('in_progress', 'todo', 'failure_requeue')).toBe(true);
    expect(canTransitionTaskStatus('in_progress', 'blocked', 'failure_block')).toBe(true);
    expect(canTransitionTaskStatus('todo', 'blocked', 'claim')).toBe(false);
  });
});

describe('derived dependency readiness', () => {
  it('accepts done and released dependencies without storing a new task status', () => {
    const task = { status: 'todo' as const, dependsOn: ['task-a', 'task-b'] };
    expect(deriveDependencyReadiness(task, new Map([['task-a', 'done'], ['task-b', 'released']])))
      .toEqual({ kind: 'ready', waitingOn: [] });
    expect(task.status).toBe('todo');
  });

  it('reports missing or unfinished dependencies without marking the task blocked', () => {
    expect(deriveDependencyReadiness(
      { status: 'todo', dependsOn: ['task-a', 'task-b', 'task-b'] },
      new Map([['task-a', 'in_progress']]),
    )).toEqual({ kind: 'waiting_for_dependencies', waitingOn: ['task-a', 'task-b'] });
    expect(deriveDependencyReadiness({ status: 'blocked', dependsOn: [] }, new Map()))
      .toEqual({ kind: 'status_not_todo', waitingOn: [] });
  });
});
