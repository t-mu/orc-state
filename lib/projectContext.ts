import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalProjectGitRoot, projectDataHome, ProjectRegistry, type ProjectRecord } from './projectRegistry.ts';

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
  source: 'environment' | 'cwd';
}

const LEGACY_CONFIG = 'orc-state.config.json';

/** A legacy attached or sibling layout keeps working until it is migrated. */
function hasLegacyLayout(cwd: string, gitRoot: string): boolean {
  if (existsSync(join(gitRoot, '.orc-state'))) return true;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, LEGACY_CONFIG))) return true;
    if (dirname(dir) === dir) return false;
  }
}

function toActive(record: ProjectRecord, source: ActiveProject['source']): ActiveProject {
  return { id: record.id, name: record.name, stateDir: record.stateDir, targetRepoRoot: record.canonicalGitRoot, source };
}

/**
 * Select the active project. An explicit `ORC_PROJECT_ID` (set by the
 * coordinator for its workers, or by an operator) always wins and must be
 * registered. Otherwise explicit legacy path overrides (`ORC_STATE_DIR`,
 * `ORC_HOME`, `ORC_REPO_ROOT`, `ORC_CONFIG_FILE`) keep legacy mode. Otherwise
 * the current directory's canonical Git root selects its registered project,
 * unless that repository still carries a legacy orc layout.
 */
export function resolveActiveProject(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ActiveProject | null {
  const registryFile = join(projectDataHome(env), 'registry.db');
  const explicitId = env.ORC_PROJECT_ID?.trim();
  if (explicitId) {
    if (!existsSync(registryFile)) throw new Error(`ORC_PROJECT_ID=${explicitId} but no project registry exists at ${registryFile}`);
    const registry = new ProjectRegistry(projectDataHome(env));
    try {
      const record = registry.get(explicitId);
      if (!record) throw new Error(`ORC_PROJECT_ID is not a registered project: ${explicitId}`);
      return toActive(record, 'environment');
    } finally {
      registry.close();
    }
  }
  if (env.ORC_STATE_DIR || env.ORC_HOME || env.ORC_REPO_ROOT || env.ORC_CONFIG_FILE) return null;
  if (!existsSync(registryFile)) return null;
  let gitRoot: string;
  try {
    gitRoot = canonicalProjectGitRoot(cwd);
  } catch {
    return null;
  }
  const registry = new ProjectRegistry(projectDataHome(env));
  try {
    const matches = registry.list().filter((project) => project.canonicalGitRoot === gitRoot);
    if (matches.length !== 1 || hasLegacyLayout(cwd, gitRoot)) return null;
    return toActive(matches[0], 'cwd');
  } finally {
    registry.close();
  }
}

/**
 * Stored registry settings for the project (project over global), shaped like
 * the legacy config file so the existing loaders apply CLI and environment
 * overrides on top.
 */
export function projectConfigObject(project: ActiveProject, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const registry = new ProjectRegistry(projectDataHome(env));
  try {
    const settings = { ...registry.settings(), ...registry.settings(project.id) };
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
  } finally {
    registry.close();
  }
}
