import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * lib/tui renders only data obtained through orc-state/client, so the
 * cockpit and the desktop app share one data path. Its non-test modules may
 * import: other lib/tui modules, the client entry (`client.ts` /
 * `orc-state/client`), npm packages and Node built-ins, and the pure
 * formatting helpers below. Never state readers, `STATE_DIR`/paths, SQLite
 * stores or any other runtime internal.
 */
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const TUI_DIR = join(REPO_ROOT, 'lib', 'tui');
const CLIENT_ENTRY = join(REPO_ROOT, 'client.ts');
/** Formatting helpers with no runtime import of another repo module (checked below). */
const PURE_HELPERS = new Set(['lib/banner.ts', 'lib/currentActivity.ts'].map((path) => join(REPO_ROOT, path)));

interface ImportRef { specifier: string; typeOnly: boolean }

/** Every static, re-export and dynamic import of `source`; `typeOnly` for `import type` / `export type`. */
function importsOf(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const match of source.matchAll(/(?:^|[\n;])\s*(import|export)\s+(type\s+)?[^'";]*?\sfrom\s+['"]([^'"]+)['"]/g)) {
    refs.push({ specifier: match[3], typeOnly: Boolean(match[2]) });
  }
  for (const match of source.matchAll(/(?:^|[\n;])\s*import\s+['"]([^'"]+)['"]/g)) refs.push({ specifier: match[1], typeOnly: false });
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) refs.push({ specifier: match[1], typeOnly: false });
  return refs;
}

/** Why importing `ref` from the lib/tui file `file` breaks the boundary, or null when it is allowed. */
function boundaryViolation(file: string, ref: ImportRef): string | null {
  const { specifier } = ref;
  if (!specifier.startsWith('.')) {
    // Packages and built-ins are fine; the root `orc-state` entry is the full runtime.
    if (specifier === 'orc-state' || (specifier.startsWith('orc-state/') && specifier !== 'orc-state/client')) {
      return `${specifier} is not the client entry`;
    }
    return null;
  }
  const target = resolve(dirname(file), specifier);
  if (target === CLIENT_ENTRY || target.startsWith(`${TUI_DIR}/`)) return null;
  if (PURE_HELPERS.has(target)) return null;
  return `${relative(REPO_ROOT, target)} is not orc-state/client`;
}

function tuiSourceFiles(dir: string = TUI_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tuiSourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function violations(file: string, source: string): string[] {
  return importsOf(source)
    .map((ref) => boundaryViolation(file, ref))
    .filter((reason): reason is string => reason !== null)
    .map((reason) => `${relative(REPO_ROOT, file)}: ${reason}`);
}

describe('lib/tui import boundary', () => {
  it('lib/tui imports nothing but orc-state/client, its own modules and pure helpers', () => {
    const files = tuiSourceFiles();
    expect(files.length).toBeGreaterThan(5);
    expect(files.flatMap((file) => violations(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('the pure helpers import no other repo module at runtime', () => {
    for (const helper of PURE_HELPERS) {
      const runtime = importsOf(readFileSync(helper, 'utf8')).filter((ref) => !ref.typeOnly && ref.specifier.startsWith('.'));
      expect(runtime, relative(REPO_ROOT, helper)).toEqual([]);
    }
  });

  it('fails on a state reader, paths, a store or another internal (negative cases)', () => {
    const file = join(TUI_DIR, 'Example.tsx');
    const source = [
      "import { buildStatus } from '../statusView.ts';",
      "import { STATE_DIR } from '../paths.ts';",
      "import {\n  readClaims,\n} from '../stateReader.ts';",
      "import type { Claim } from '../../types/claims.ts';",
      "export { openTaskStore } from '../projectTaskStore.ts';",
      "const lazy = import('../eventLog.ts');",
      "import 'orc-state';",
    ].join('\n');
    expect(violations(file, source)).toEqual([
      'lib/tui/Example.tsx: lib/statusView.ts is not orc-state/client',
      'lib/tui/Example.tsx: lib/paths.ts is not orc-state/client',
      'lib/tui/Example.tsx: lib/stateReader.ts is not orc-state/client',
      'lib/tui/Example.tsx: types/claims.ts is not orc-state/client',
      'lib/tui/Example.tsx: lib/projectTaskStore.ts is not orc-state/client',
      'lib/tui/Example.tsx: orc-state is not the client entry',
      'lib/tui/Example.tsx: lib/eventLog.ts is not orc-state/client',
    ]);
  });

  it('allows the client entry, lib/tui modules, packages and pure helpers', () => {
    const file = join(TUI_DIR, 'Example.tsx');
    const source = [
      "import type { StatusView } from '../../client.ts';",
      "import { ProjectWatcher } from 'orc-state/client';",
      "import { Box } from 'ink';",
      "import { stripVTControlCharacters } from 'node:util';",
      "import { Header } from './Header.tsx';",
      "import { renderBanner } from '../banner.ts';",
      "import type { CurrentActivity } from '../currentActivity.ts';",
    ].join('\n');
    expect(violations(file, source)).toEqual([]);
  });
});
