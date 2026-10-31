import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const CONFIG_FILENAME = 'orc-state.config.json';

export function resolveRepoRoot(cwd: string = process.cwd()): string {
  const forced = process.env.ORC_REPO_ROOT;
  if (forced) return resolve(forced);

  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return resolve(cwd);
  }
  return dirname(result.stdout.trim());
}

/** Walk up from cwd toward the filesystem root looking for orc-state.config.json. */
function findConfigDirUpwards(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the orchestration root of a legacy (unmigrated) installation — the
 * directory that owns orc-state.config.json, .orc-state/, backlog/, plans/,
 * and .worktrees/. This is a fallback: a registered project (lib/projectContext.ts)
 * is selected first, and a legacy root is only used when none applies.
 *
 * Precedence: ORC_HOME, then the existing ORC_REPO_ROOT override, then
 * directory walk-up locating orc-state.config.json, then git-based
 * resolution via resolveRepoRoot().
 *
 * A walk-up hit is normalized to the git main checkout when that checkout
 * also carries a config file: in the attached layout the config is checked
 * in, so a worker whose cwd is .worktrees/<run>/ would otherwise resolve
 * state paths to its own worktree copy instead of the shared main checkout.
 */
export function resolveOrchestrationRoot(cwd: string = process.cwd()): string {
  const home = process.env.ORC_HOME;
  if (home) return resolve(home);
  const forced = process.env.ORC_REPO_ROOT;
  if (forced) return resolve(forced);

  const configDir = findConfigDirUpwards(cwd);
  if (configDir) {
    const gitRoot = resolveRepoRoot(configDir);
    if (gitRoot !== configDir && existsSync(join(gitRoot, CONFIG_FILENAME))) return gitRoot;
    return configDir;
  }
  return resolveRepoRoot(cwd);
}
