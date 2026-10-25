import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { canonicalProjectGitRoot, OutsideGitRepositoryError, projectDataHome, ProjectRegistry, PROJECT_DESCRIPTOR as DESCRIPTOR, type ProjectRecord } from './projectRegistry.ts';

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

/** A project's migration record, or null when the project was not migrated (or the record is unreadable). */
export function readMigrationRecord(stateDir: string): { status: string; source_root?: string; source_state_dir?: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, MIGRATION_RECORD), 'utf8')) as Record<string, unknown>;
    return { ...parsed, status: typeof parsed.status === 'string' ? parsed.status : 'unknown' } as { status: string; source_root?: string; source_state_dir?: string };
  } catch {
    return null;
  }
}

/** The status of a project's migration from a legacy installation, or null when it was not migrated. */
export function projectMigrationStatus(stateDir: string): string | null {
  if (!existsSync(join(stateDir, MIGRATION_RECORD))) return null;
  return readMigrationRecord(stateDir)?.status ?? 'unknown';
}

function isActivatable(record: ProjectRecord): boolean {
  const status = projectMigrationStatus(record.stateDir);
  return status === null || status === 'cut_over';
}

/** The nearest legacy attached or sibling layout from cwd up to `top` (the repository root, or the filesystem root). */
function findLegacyLayout(cwd: string, top: string | null): string | null {
  let dir = resolve(cwd);
  if (top && !within(top, dir)) dir = top;
  for (;;) {
    if (existsSync(join(dir, '.orc-state')) || existsSync(join(dir, LEGACY_CONFIG))) return dir;
    if (dir === top || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}

/**
 * The cut-over project a legacy installation root was migrated to: named by
 * the marker in its state directory, or, once that directory has been
 * cleaned up, by the project's own migration record.
 */
function migratedProject(registry: ProjectRegistry, legacyRoot: string): ProjectRecord | null {
  const marker = readMigrationMarker(join(legacyRoot, '.orc-state'));
  if (marker) {
    const record = registry.get(marker.project_id);
    if (record && isActivatable(record)) return record;
  }
  return registry.list().find((project) => {
    const migration = readMigrationRecord(project.stateDir);
    return migration?.status === 'cut_over' && migration.source_root === legacyRoot;
  }) ?? null;
}

/** The legacy state directory an explicit legacy override points at. */
function legacyOverrideStateDir(env: NodeJS.ProcessEnv): string {
  if (env.ORC_STATE_DIR) return resolve(env.ORC_STATE_DIR);
  if (env.ORC_HOME) return join(resolve(env.ORC_HOME), '.orc-state');
  if (env.ORC_CONFIG_FILE) return join(dirname(resolve(env.ORC_CONFIG_FILE)), '.orc-state');
  return join(resolve(env.ORC_REPO_ROOT!), '.orc-state');
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
 * `ORC_CONFIG_FILE`) keep legacy mode unless they name a migrated legacy
 * state directory, which selects its project; inside a Git repository its canonical
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
  if (env.ORC_STATE_DIR || env.ORC_HOME || env.ORC_REPO_ROOT || env.ORC_CONFIG_FILE) {
    // An override naming a migrated legacy state directory (a stale MCP config, an old shell) reaches its project instead.
    const legacyState = legacyOverrideStateDir(env);
    const marker = readMigrationMarker(legacyState);
    if (!marker || !existsSync(registryFile)) return null;
    return withRegistry(env, (registry) => {
      const record = registry.get(marker.project_id);
      return record && isActivatable(record) ? toActive(record, 'environment') : null;
    });
  }
  if (!existsSync(registryFile)) return null;
  let gitRoot: string | null;
  try {
    gitRoot = canonicalProjectGitRoot(cwd);
  } catch (error) {
    // Only "not a repository" means outside Git; any other Git failure must not fall back to the selected project.
    if (!(error instanceof OutsideGitRepositoryError)) {
      const raw = (error as { stderr?: Buffer | string }).stderr;
      const stderr = typeof raw === 'string' ? raw : raw?.toString('utf8') ?? '';
      const cause = /^(?:fatal|error): .*$/m.exec(stderr)?.[0] ?? (error as Error).message.split('\n')[0];
      throw new Error(`Cannot identify the Git repository at ${cwd} (${cause}); fix it or pass --project`);
    }
    gitRoot = null;
  }
  const legacyDir = findLegacyLayout(cwd, gitRoot);
  return withRegistry(env, (registry) => {
    // A legacy layout keeps legacy mode until its migration is cut over; then it names its project.
    if (legacyDir) {
      // From a linked worktree the layout found may be the worktree's checked-in config; the main checkout migrated.
      const record = migratedProject(registry, legacyDir) ?? (gitRoot && gitRoot !== legacyDir ? migratedProject(registry, gitRoot) : null);
      if (record) return toActive(record, 'cwd');
      if (gitRoot) return null;
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
