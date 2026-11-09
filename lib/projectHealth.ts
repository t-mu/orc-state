import { checkProjectLayout } from './projectLayoutCheck.ts';
import { projectDataHome } from './projectRegistry.ts';
import { projectTaskStoreFor } from './projectTasks.ts';
import type { ActiveProject, ProjectSelectedBy } from './projectContext.ts';

export interface ProjectHealth {
  ok: boolean;
  project: { id: string; name: string; target_repo_root: string; state_dir: string; source: ActiveProject['source']; selected_by: ProjectSelectedBy };
  errors: string[];
  warnings: string[];
}

/**
 * Health of the selected project: the target repository is a reachable Git
 * repository with writable metadata, the external state directory and data
 * home are writable, run worktrees live outside the target working tree, the
 * project task store opens at the current schema, and no orc artifacts sit in
 * the target working tree (a warning).
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
    project: { id: project.id, name: project.name, target_repo_root: project.targetRepoRoot, state_dir: stateDir, source: project.source, selected_by: project.selectedBy },
    errors,
    warnings: layout.warnings,
  };
}

/** One line naming the project a command acts on, and how it was selected when known. */
export function formatProjectIdentity(project: { id: string; name: string; target_repo_root: string; selected_by?: ProjectSelectedBy | undefined } | null): string {
  if (!project) return 'project: (none selected)';
  const how = project.selected_by ? ` (selected by ${SELECTED_BY_LABEL[project.selected_by]})` : '';
  return `project: ${project.name} (${project.id}) → ${project.target_repo_root}${how}`;
}

const SELECTED_BY_LABEL: Record<ProjectSelectedBy, string> = {
  flag: '--project',
  env: 'ORC_PROJECT_ID',
  cwd: 'current directory',
  selected: 'orc project select',
};
