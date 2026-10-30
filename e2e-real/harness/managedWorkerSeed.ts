/**
 * e2e-real/harness/managedWorkerSeed.ts
 *
 * Seeds the tasks needed for task-scoped worker dispatch into the temp repo's
 * registered project. The coordinator should pick them up on its first tick
 * and launch a real worker session without needing a master session.
 *
 * This mirrors the blessed task-authoring path: each task is created with
 * `orc project task create` in the project's SQLite store (`todo`,
 * `ready_for_dispatch`), with its `depends_on` and Markdown body. Registering
 * the project already initialized empty agents, claims and events.
 *
 * Invariant: no master-only state is seeded.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../../types/backlog.ts';
import type { RuntimeRepo } from './runtimeRepo.ts';

export interface SeedTask extends Pick<Task, 'ref' | 'title'> {
  depends_on?: string[];
  /** Task body Markdown; without one the store renders a body from the title. */
  body?: string;
}

/**
 * Create `tasks` (refs of the form `<feature>/<slug>`) in the repo's project.
 *
 * After seeding, the coordinator can be started against the project and it
 * will take the managed dispatch path on its first tick.
 */
export function seedManagedWorkerBaseline(repo: RuntimeRepo, tasks: SeedTask[]): void {
  // Bodies are written outside the target repo; create reads them in this process.
  const bodyDir = mkdtempSync(join(repo.root, 'task-bodies-'));

  for (const task of tasks) {
    const slash = task.ref.indexOf('/');
    if (slash <= 0) throw new Error(`seedManagedWorkerBaseline: task ref must be <feature>/<slug>: ${task.ref}`);
    const args = [
      'project', 'task', 'create',
      `--feature=${task.ref.slice(0, slash)}`,
      `--ref=${task.ref.slice(slash + 1)}`,
      `--title=${task.title}`,
    ];
    if (task.depends_on != null && task.depends_on.length > 0) args.push(`--depends-on=${task.depends_on.join(',')}`);
    if (task.body != null) {
      const bodyFile = join(bodyDir, `${task.ref.replace(/\//g, '-')}.md`);
      writeFileSync(bodyFile, task.body);
      args.push(`--body-file=${bodyFile}`);
    }
    repo.orc(args);
  }
}
