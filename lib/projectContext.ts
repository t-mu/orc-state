import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
 * Select the active project, following docs/configuration.md (project selection):
 * an explicit `ORC_PROJECT_ID` (set by `--project`, by an operator, or by the
 * coordinator for its workers) wins and must be registered; inside a Git
 * repository its canonical root selects the registered project (an ambiguous
 * match is an error); outside every repository the project chosen with
 * `orc project select` applies.
 *
 * A worker gets `ORC_STATE_DIR` beside its `ORC_PROJECT_ID`: when that
 * directory's descriptor names the same project, the project resolves from it
 * without opening the registry (a sandboxed worker may not reach it).
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
    return toActive(record, 'environment');
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
  return withRegistry(env, (registry) => {
    if (gitRoot == null) {
      const selected = registry.selectedId();
      const record = selected ? registry.get(selected) : null;
      return record ? toActive(record, 'selected') : null;
    }
    const matches = registry.list().filter((project) => project.canonicalGitRoot === gitRoot);
    if (matches.length > 1) throw new Error(`Git repository matches multiple projects: ${gitRoot}; pass --project`);
    return matches.length === 1 ? toActive(matches[0], 'cwd') : null;
  });
}

/**
 * Stored registry settings as nested objects (`worker_pool.max_workers` →
 * `{ worker_pool: { max_workers } }`): the project's over the global ones, or
 * only the global ones when no project is active. The loaders in
 * lib/providers.ts apply environment overrides on top. A process that cannot
 * open the registry (a sandboxed worker), or a machine without one, gets no
 * stored settings and runs on environment and defaults.
 */
export function projectConfigObject(project: ActiveProject | null, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  if (!project && !existsSync(join(projectDataHome(env), 'registry.db'))) return {};
  let settings: Record<string, unknown>;
  try {
    settings = withRegistry(env, (registry) => ({ ...registry.settings(), ...(project ? registry.settings(project.id) : {}) }));
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
