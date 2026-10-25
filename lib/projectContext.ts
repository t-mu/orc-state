import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { canonicalProjectGitRoot, projectDataHome, ProjectRegistry, PROJECT_DESCRIPTOR as DESCRIPTOR, type ProjectRecord } from './projectRegistry.ts';

export { writeProjectDescriptor } from './projectRegistry.ts';

/**
 * The registered project an orc process operates on, when it runs in project
 * mode. Project mode places every harness artifact (state, worktrees, logs,
 * provider settings, plans) under the project's external state directory and
 * runs Git operations against the registered target repository, so nothing
 * is written into the target working tree.
 */
export interface ActiveProject {
  id: string;
  name: string;
  stateDir: string;
  targetRepoRoot: string;
  source: 'environment' | 'cwd' | 'selected';
}

const LEGACY_CONFIG = 'orc-state.config.json';

export function readProjectDescriptor(stateDir: string): { id: string; name: string; target_repo_root: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, DESCRIPTOR), 'utf8')) as Record<string, unknown>;
    return typeof parsed.id === 'string' && typeof parsed.name === 'string' && typeof parsed.target_repo_root === 'string'
      ? { id: parsed.id, name: parsed.name, target_repo_root: parsed.target_repo_root }
      : null;
  } catch {
    return null;
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Written into a legacy state directory when its installation is cut over to a project (task 226). */
export const MIGRATION_MARKER = 'project-migration.json';
/** A project state directory's migration record; a project is inactive until its migration is cut over. */
export const MIGRATION_RECORD = 'migration.json';

export interface MigrationMarker { project_id: string; project_name: string; project_state_dir: string; target_repo_root: string; migrated_at: string }

export function readMigrationMarker(legacyStateDir: string): MigrationMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(join(legacyStateDir, MIGRATION_MARKER), 'utf8')) as Record<string, unknown>;
    return typeof parsed.project_id === 'string' && typeof parsed.project_state_dir === 'string' ? parsed as unknown as MigrationMarker : null;
  } catch {
    return null;
  }
}

/** The status of a project's migration from a legacy installation, or null when it was not migrated. */
export function projectMigrationStatus(stateDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, MIGRATION_RECORD), 'utf8')) as Record<string, unknown>;
    return typeof parsed.status === 'string' ? parsed.status : 'unknown';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unknown';
  }
}

function isActivatable(record: ProjectRecord): boolean {
  const status = projectMigrationStatus(record.stateDir);
  return status === null || status === 'cut_over';
}

/** The nearest legacy attached or sibling layout between cwd and the repository root. */
function findLegacyLayout(cwd: string, gitRoot: string): string | null {
  let dir = resolve(cwd);
  if (!within(gitRoot, dir)) dir = gitRoot;
  for (;;) {
    if (existsSync(join(dir, '.orc-state')) || existsSync(join(dir, LEGACY_CONFIG))) return dir;
    if (dir === gitRoot || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}

function toActive(record: ProjectRecord, source: ActiveProject['source']): ActiveProject {
  return { id: record.id, name: record.name, stateDir: record.stateDir, targetRepoRoot: record.canonicalGitRoot, source };
}

function withRegistry<T>(env: NodeJS.ProcessEnv, operation: (registry: ProjectRegistry) => T): T {
  const registry = new ProjectRegistry(projectDataHome(env));
  try {
    return operation(registry);
  } finally {
    registry.close();
  }
}

/**
 * Select the active project, following docs/global-project-contract.md:
 * an explicit `ORC_PROJECT_ID` (set by `--project`, by an operator, or by the
 * coordinator for its workers) wins and must be registered; explicit legacy
 * path overrides (`ORC_STATE_DIR`, `ORC_HOME`, `ORC_REPO_ROOT`,
 * `ORC_CONFIG_FILE`) keep legacy mode; inside a Git repository its canonical
 * root selects the registered project (an ambiguous match is an error), unless
 * the repository still carries a legacy orc layout (which selects its project
 * only once migrated); outside every repository the selected project applies.
 * A project whose migration has not been cut over is not active yet.
 */
export function resolveActiveProject(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ActiveProject | null {
  const registryFile = join(projectDataHome(env), 'registry.db');
  const explicitId = env.ORC_PROJECT_ID?.trim();
  if (explicitId) {
    const bridge = env.ORC_STATE_DIR?.trim();
    const descriptor = bridge ? readProjectDescriptor(resolve(bridge)) : null;
    if (bridge && descriptor?.id === explicitId) {
      return { id: descriptor.id, name: descriptor.name, stateDir: resolve(bridge), targetRepoRoot: descriptor.target_repo_root, source: 'environment' };
    }
    if (!existsSync(registryFile)) throw new Error(`ORC_PROJECT_ID=${explicitId} but no project registry exists at ${registryFile}`);
    const record = withRegistry(env, (registry) => registry.get(explicitId));
    if (!record) throw new Error(`ORC_PROJECT_ID is not a registered project: ${explicitId}`);
    if (!isActivatable(record)) throw new Error(`Project ${explicitId} is still being migrated; rerun orc project migrate --execute to finish`);
    return toActive(record, 'environment');
  }
  if (env.ORC_STATE_DIR || env.ORC_HOME || env.ORC_REPO_ROOT || env.ORC_CONFIG_FILE) return null;
  if (!existsSync(registryFile)) return null;
  let gitRoot: string | null;
  try {
    gitRoot = canonicalProjectGitRoot(cwd);
  } catch {
    gitRoot = null;
  }
  const legacyDir = gitRoot ? findLegacyLayout(cwd, gitRoot) : null;
  return withRegistry(env, (registry) => {
    // A legacy layout keeps legacy mode until its migration is cut over; then it names its project.
    if (legacyDir) {
      const marker = readMigrationMarker(join(legacyDir, '.orc-state'));
      const record = marker ? registry.get(marker.project_id) : null;
      return record && isActivatable(record) ? toActive(record, 'cwd') : null;
    }
    if (gitRoot == null) {
      const selected = registry.selectedId();
      const record = selected ? registry.get(selected) : null;
      return record && isActivatable(record) ? toActive(record, 'selected') : null;
    }
    const matches = registry.list().filter((project) => project.canonicalGitRoot === gitRoot);
    if (matches.length > 1) throw new Error(`Git repository matches multiple projects: ${gitRoot}; pass --project`);
    return matches.length === 1 && isActivatable(matches[0]) ? toActive(matches[0], 'cwd') : null;
  });
}

/**
 * Stored registry settings for the project (project over global), shaped like
 * the legacy config file so the existing loaders apply CLI and environment
 * overrides on top. A process that cannot open the registry (a sandboxed
 * worker) gets no stored settings and runs on environment and defaults.
 */
export function projectConfigObject(project: ActiveProject, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  let settings: Record<string, unknown>;
  try {
    settings = withRegistry(env, (registry) => ({ ...registry.settings(), ...registry.settings(project.id) }));
  } catch {
    return {};
  }
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === null) continue;
    const parts = key.split('.');
    let node = config;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts.at(-1)!] = value;
  }
  return config;
}
