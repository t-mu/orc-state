import type { ControlClient, ProjectTaskSummary, ProjectTaskView, TaskRevisionSummary } from '../../client.ts';

// The task explorer's pure logic. It reads tasks only: TuiTaskClient carries
// no write method, so no explorer code path can create, edit or reset a task.

/** The read-only task routes the explorer calls (`GET /v1/tasks…`). */
export type TuiTaskClient = Pick<ControlClient, 'listTasks' | 'getTask' | 'taskRevisions'>;
export type { ProjectTaskSummary, ProjectTaskView, TaskRevisionSummary };

/** Filter value that keeps every task. */
export const ALL = 'all';

/** Task statuses in lifecycle order; statuses this client does not know sort after them. */
const STATUS_ORDER = ['todo', 'claimed', 'in_progress', 'blocked', 'done', 'cancelled'];

export interface TaskFilter { status: string; feature: string }

/** The status filter values: `all`, then each status the tasks carry, in lifecycle order. */
export function statusOptions(tasks: ProjectTaskSummary[]): string[] {
  const present = [...new Set(tasks.map(task => task.status))];
  const rank = (status: string) => {
    const index = STATUS_ORDER.indexOf(status);
    return index === -1 ? STATUS_ORDER.length : index;
  };
  return [ALL, ...present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))];
}

/** The feature filter values: `all`, then each feature the tasks belong to, sorted. */
export function featureOptions(tasks: ProjectTaskSummary[]): string[] {
  return [ALL, ...[...new Set(tasks.map(task => task.feature_ref))].sort()];
}

export function filterTasks(tasks: ProjectTaskSummary[], filter: TaskFilter): ProjectTaskSummary[] {
  return tasks.filter(task => (filter.status === ALL || task.status === filter.status)
    && (filter.feature === ALL || task.feature_ref === filter.feature));
}

/** The option after `current` (wrapping); the first one when `current` is not among them. */
export function cycleOption(options: string[], current: string): string {
  const index = options.indexOf(current);
  return options[(index + 1) % options.length] ?? ALL;
}

/** Break `text` into lines no wider than `width`, at spaces where possible; blank lines are kept. */
export function wrapText(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.replace(/\t/g, '  ').split(/\r?\n/)) {
    let line = raw.trimEnd();
    if (line.length === 0) {
      out.push('');
      continue;
    }
    while (line.length > max) {
      const space = line.lastIndexOf(' ', max);
      const cut = space > 0 ? space : max;
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^ /, '');
    }
    out.push(line);
  }
  return out;
}

/** The first visible index that keeps `selected` inside a window of `size` rows over `count` items. */
export function windowStart(selected: number, count: number, size: number): number {
  if (size <= 0 || count <= size) return 0;
  return Math.min(Math.max(0, selected - Math.floor(size / 2)), count - size);
}

/** Clamp a scroll offset to `[0, total - page]`. */
export function clampScroll(offset: number, total: number, page: number): number {
  return Math.max(0, Math.min(offset, total - page));
}

/** A task's detail as scrollable lines: its fields, its revision list, then its spec markdown, wrapped to `width`. */
export function detailLines(task: ProjectTaskView, revisions: TaskRevisionSummary[], width: number): string[] {
  const fields = [
    `title: ${task.title}`,
    `status: ${task.status}${task.blocked_reason ? ` (${task.blocked_reason})` : ''}`,
    `priority: ${task.priority ?? 'normal'}`,
    `feature: ${task.feature_ref}`,
    `depends on: ${task.depends_on?.length ? task.depends_on.join(', ') : '(none)'}`,
  ];
  const revisionLines = revisions.length === 0
    ? ['  (none)']
    : revisions.map(revision => `  r${revision.revision}  ${revision.createdAt}  ${revision.title}`);
  return [
    ...fields.flatMap(line => wrapText(line, width)),
    '',
    `Revisions (${revisions.length})`,
    ...revisionLines.flatMap(line => wrapText(line, width)),
    '',
    `Spec (revision ${task.spec_revision ?? '?'})`,
    ...wrapText(task.body_markdown || '(empty spec)', width),
  ];
}
