import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ORC_PACKAGE_ROOT } from './paths.ts';

/** What a running coordinator loaded: reported by `GET /v1/health`, compared on disk by `orc doctor`. */
export interface CodeIdentity {
  code_root: string;
  /** ISO time of the newest coordinator entry or `lib/` file at startup. */
  code_mtime: string;
  /** Names the build: the hash `scripts/build.ts` wrote into `dist/`, or `git-<sha>` for a source checkout; null when unknowable. */
  build_id: string | null;
}

/** File in `dist/` holding the content hash of the compiled `.js`; written last by `scripts/build.ts`. */
export const BUILD_ID_FILE = 'build-id';

const SOURCE = /\.(ts|js)$/;

/**
 * Newest mtime of the coordinator entry module and the `lib/` files it runs, `.ts` or `.js` alike so the
 * same walk fits a source checkout and `dist/`. Tests and declaration files are not loaded. Null when nothing is found.
 */
export function newestCodeMtimeMs(codeRoot: string): number | null {
  const files = [join(codeRoot, 'coordinator.ts'), join(codeRoot, 'coordinator.js')];
  try {
    for (const name of readdirSync(join(codeRoot, 'lib'))) {
      if (SOURCE.test(name) && !name.endsWith('.d.ts') && !name.includes('.test.')) files.push(join(codeRoot, 'lib', name));
    }
  } catch { /* no lib directory */ }
  let newest: number | null = null;
  for (const file of files) {
    try {
      const mtime = Math.floor(statSync(file).mtimeMs); // whole ms, as `code_mtime` carries
      if (newest === null || mtime > newest) newest = mtime;
    } catch { /* absent entry variant */ }
  }
  return newest;
}

/** A source checkout runs `.ts` from the repository root; a build or installed package runs `.js` from `dist/`. */
const isSourceCheckout = (codeRoot: string): boolean => existsSync(join(codeRoot, 'coordinator.ts'));

/** The build id on disk: the file `scripts/build.ts` wrote, or the checkout's git HEAD for source runs. */
export function readBuildId(codeRoot: string): string | null {
  try {
    const id = readFileSync(join(codeRoot, BUILD_ID_FILE), 'utf8').trim();
    if (id) return id;
  } catch { /* not a build */ }
  if (!isSourceCheckout(codeRoot)) return null;
  try {
    const sha = execFileSync('git', ['-C', codeRoot, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return sha ? `git-${sha}` : null;
  } catch { return null; }
}

/** The package version on disk: `package.json` at the checkout root, or beside `dist/`. */
export function readPackageVersion(codeRoot: string): string | null {
  for (const file of [join(codeRoot, 'package.json'), join(codeRoot, '..', 'package.json')]) {
    try {
      const { version } = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
      if (typeof version === 'string') return version;
    } catch { /* try the next location */ }
  }
  return null;
}

export function captureCodeIdentity(codeRoot: string = ORC_PACKAGE_ROOT): CodeIdentity {
  const mtime = newestCodeMtimeMs(codeRoot);
  return { code_root: codeRoot, code_mtime: new Date(mtime ?? 0).toISOString(), build_id: readBuildId(codeRoot) };
}

/**
 * The restart warning when the code on disk differs from what the coordinator loaded; null when current or unknowable (no build id on disk).
 * Built code is judged by `version` and `build_id` (npm normalises tarball mtimes, so they say nothing there);
 * a source checkout also by file mtimes, since uncommitted edits do not change its build id.
 */
export function staleCodeWarning(running: CodeIdentity & { version?: string }): string | null {
  const diskVersion = readPackageVersion(running.code_root);
  if (running.version && diskVersion && running.version !== diskVersion) {
    return `coordinator is running version ${running.version}, disk has ${diskVersion}; restart with orc start-session --restart-stale`;
  }
  const diskBuild = readBuildId(running.code_root);
  if (running.build_id && diskBuild && running.build_id !== diskBuild) {
    return `coordinator is running build ${running.build_id}, disk has ${diskBuild}; restart with orc start-session --restart-stale`;
  }
  // A coordinator started before health carried identity reports neither; it is older than any build on disk.
  if (diskBuild && !running.build_id && !running.version) {
    return 'coordinator reports no build id (older than this build); restart with orc start-session --restart-stale';
  }
  if (!isSourceCheckout(running.code_root)) return null;
  const onDisk = newestCodeMtimeMs(running.code_root);
  if (onDisk === null || onDisk <= Date.parse(running.code_mtime)) return null;
  return `coordinator is running code from ${running.code_mtime}; restart with orc start-session --restart-stale`;
}
