import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

export function resolveRepoRoot(cwd = process.cwd()) {
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
