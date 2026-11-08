import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ORC_PACKAGE_ROOT } from './paths.ts';

/** What a running coordinator loaded: reported by `GET /v1/health`, compared on disk by `orc doctor`. */
export interface CodeIdentity {
  code_root: string;
  /** ISO time of the newest coordinator entry or `lib/` file at startup. */
  code_mtime: string;
}

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

export function captureCodeIdentity(codeRoot: string = ORC_PACKAGE_ROOT): CodeIdentity {
  const mtime = newestCodeMtimeMs(codeRoot);
  return { code_root: codeRoot, code_mtime: new Date(mtime ?? 0).toISOString() };
}

/** The restart warning when the code on disk is newer than what the coordinator loaded; null when current or unknowable. */
export function staleCodeWarning(running: CodeIdentity): string | null {
  const onDisk = newestCodeMtimeMs(running.code_root);
  if (onDisk === null || onDisk <= Date.parse(running.code_mtime)) return null;
  return `coordinator is running code from ${running.code_mtime}; restart with orc start-session`;
}
