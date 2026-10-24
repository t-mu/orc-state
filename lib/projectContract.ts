import type { TaskStatus } from '../types/backlog.ts';

export interface RegisteredProjectIdentity {
  id: string;
  canonicalGitRoot: string;
}

export type ProjectSelectionSource = 'explicit' | 'environment' | 'cwd' | 'selected';

/** Pure selection rule. Callers canonicalize Git roots before invoking it. */
export function selectProject(
  {
    projects,
    explicitProjectId,
    environmentProjectId,
    cwdGitRoot,
    selectedProjectId,
  }: {
    projects: readonly RegisteredProjectIdentity[];
    explicitProjectId?: string | null;
    environmentProjectId?: string | null;
    cwdGitRoot?: string | null;
    selectedProjectId?: string | null;
  },
): { projectId: string; source: ProjectSelectionSource } {
  const findById = (id: string, source: ProjectSelectionSource) => {
    if (!id.trim()) throw new Error(`Empty ${source} project id`);
    const matches = projects.filter((project) => project.id === id);
    if (matches.length !== 1) throw new Error(`${source} project id is not uniquely registered: ${id}`);
    return { projectId: id, source };
  };

  if (explicitProjectId != null) return findById(explicitProjectId, 'explicit');
  if (environmentProjectId != null) return findById(environmentProjectId, 'environment');
  if (cwdGitRoot != null) {
    const matches = projects.filter((project) => project.canonicalGitRoot === cwdGitRoot);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `Git repository is not registered: ${cwdGitRoot}`
        : `Git repository matches multiple projects: ${cwdGitRoot}`);
    }
    return { projectId: matches[0].id, source: 'cwd' };
  }
  if (selectedProjectId != null) return findById(selectedProjectId, 'selected');
  throw new Error('No project selected; pass --project or register the current Git repository');
}

export type TaskTransitionCause =
  | 'claim' | 'run_start' | 'merge_succeeded' | 'post_merge_release'
  | 'failure_requeue' | 'failure_block' | 'manual_block' | 'unblock'
  | 'operator_reset' | 'cancel';

/** Lifecycle authority, independent of where task definitions are stored. */
export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus, cause: TaskTransitionCause): boolean {
  switch (cause) {
    case 'claim': return from === 'todo' && to === 'claimed';
    case 'run_start': return from === 'claimed' && to === 'in_progress';
    case 'merge_succeeded': return from === 'in_progress' && to === 'done';
    case 'post_merge_release': return from === 'done' && to === 'released';
    case 'failure_requeue': return (from === 'claimed' || from === 'in_progress') && to === 'todo';
    case 'failure_block': return (from === 'claimed' || from === 'in_progress') && to === 'blocked';
    case 'manual_block': return from === 'todo' && to === 'blocked';
    case 'unblock': return from === 'blocked' && to === 'todo';
    case 'operator_reset': return from !== 'todo' && to === 'todo';
    case 'cancel': return !['done', 'released', 'cancelled'].includes(from) && to === 'cancelled';
  }
}

/** Missing or unfinished dependencies affect readiness, never stored status. */
export function deriveDependencyReadiness(
  task: { status: TaskStatus; dependsOn: readonly string[] },
  statusByRef: ReadonlyMap<string, TaskStatus>,
): { kind: 'ready' | 'waiting_for_dependencies' | 'status_not_todo'; waitingOn: string[] } {
  if (task.status !== 'todo') return { kind: 'status_not_todo', waitingOn: [] };
  const waitingOn = [...new Set(task.dependsOn)].filter((ref) => {
    const status = statusByRef.get(ref);
    return status !== 'done' && status !== 'released';
  });
  return waitingOn.length === 0
    ? { kind: 'ready', waitingOn }
    : { kind: 'waiting_for_dependencies', waitingOn };
}
