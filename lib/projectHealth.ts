import { checkProjectLayout } from './projectLayoutCheck.ts';
import { projectDataHome } from './projectRegistry.ts';
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
 * repository with writable metadata, the external state directory and data
 * home are writable, run worktrees live outside the target working tree, the
 * project task store opens at the current schema, and no orc artifacts sit in
 * the target working tree (a warning: a legacy layout not yet cleaned up).
 */
export function checkProjectHealth(project: ActiveProject, stateDir: string, { worktreesDir, env = process.env }: { worktreesDir?: string; env?: NodeJS.ProcessEnv } = {}): ProjectHealth {
  let dataHome: string | undefined;
  try { dataHome = projectDataHome(env); } catch { dataHome = undefined; }
  const layout = checkProjectLayout({ targetRepoRoot: project.targetRepoRoot, stateDir, dataHome, worktreesDir });
  const errors = [...layout.errors];
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
