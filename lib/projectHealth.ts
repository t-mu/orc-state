import { checkSiblingLayout } from './siblingLayoutCheck.ts';
import { projectTaskStoreFor } from './projectTasks.ts';
import type { ActiveProject } from './projectContext.ts';

export interface ProjectHealth {
  ok: boolean;
  project: { id: string; name: string; target_repo_root: string; state_dir: string; source: ActiveProject['source'] };
  errors: string[];
  warnings: string[];
}

/**
 * Health of the selected project: the target repository is a reachable Git
 * repository, the external state directory is writable, the project task
 * store opens at the current schema, and no orc artifacts sit in the target
 * working tree (a warning: an unmigrated legacy layout).
 */
export function checkProjectHealth(project: ActiveProject, stateDir: string): ProjectHealth {
  // The two-root checks are the sibling layout's; a project is always two-rooted.
  const layout = checkSiblingLayout({ isSibling: true, targetRepoRoot: project.targetRepoRoot, stateDir });
  const errors = layout.errors.map((error) => error.replace('target_repo', 'target repository'));
  try {
    if (!projectTaskStoreFor(stateDir)) errors.push(`project task store is missing: ${stateDir}/runtime.db`);
  } catch (error) {
    errors.push(`project task store cannot be opened: ${(error as Error).message}`);
  }
  return {
    ok: errors.length === 0,
    project: { id: project.id, name: project.name, target_repo_root: project.targetRepoRoot, state_dir: stateDir, source: project.source },
    errors,
    warnings: layout.warnings,
  };
}

/** One line naming the project a command acts on. */
export function formatProjectIdentity(project: { id: string; name: string; target_repo_root: string } | null): string {
  return project ? `project: ${project.name} (${project.id}) → ${project.target_repo_root}` : 'project: (legacy layout)';
}
