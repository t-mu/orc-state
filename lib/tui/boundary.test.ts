import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * lib/tui and lib/cockpit2 render only data obtained through orc-state/client,
 * so the cockpits and the desktop app share one data path. Their non-test
 * modules may import: modules of their own directory, the client entry
 * (`client.ts` / `orc-state/client`), npm packages and Node built-ins, and the
 * pure helpers below. Never state readers, `STATE_DIR`/paths, adapters, SQLite
 * stores or any other runtime internal.
 */
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const TUI_DIR = join(REPO_ROOT, 'lib', 'tui');
const BOUNDARY_DIRS = [TUI_DIR, join(REPO_ROOT, 'lib', 'cockpit2')];
const CLIENT_ENTRY = join(REPO_ROOT, 'client.ts');
/** Helpers with no runtime import of another repo module (checked below). */
const PURE_HELPERS = new Set(['lib/banner.ts', 'lib/currentActivity.ts', 'lib/terminalHost.ts', 'lib/cockpitTabs.ts', 'lib/cockpitKeys.ts', 'lib/cellWidth.ts', 'lib/providerChildEnv.ts']
  .map((path) => join(REPO_ROOT, path)));
/**
 * Pure lib/tui view models lib/cockpit2 may import: the sidebar and tab-bar models and the
 * modules they import transitively. Each is free of Ink/React and IO, and imports only
 * `client.ts` (types) or another module in this list (checked below). Ink components stay forbidden.
 */
const COCKPIT2_TUI_MODULES = new Set(['lib/tui/sidebar.ts', 'lib/tui/tabBarModel.ts', 'lib/tui/status.ts', 'lib/tui/taskList.ts']
  .map((path) => join(REPO_ROOT, path)));

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

/** Why importing `ref` from the boundary file `file` breaks the boundary, or null when it is allowed. */
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
  const ownDir = BOUNDARY_DIRS.find((dir) => file.startsWith(`${dir}/`));
  if (target === CLIENT_ENTRY || (ownDir && target.startsWith(`${ownDir}/`))) return null;
  if (PURE_HELPERS.has(target)) return null;
  if (file.startsWith(`${join(REPO_ROOT, 'lib', 'cockpit2')}/`) && COCKPIT2_TUI_MODULES.has(target)) return null;
  return `${relative(REPO_ROOT, target)} is not orc-state/client`;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function violations(file: string, source: string): string[] {
  return importsOf(source)
    .map((ref) => boundaryViolation(file, ref))
    .filter((reason): reason is string => reason !== null)
    .map((reason) => `${relative(REPO_ROOT, file)}: ${reason}`);
}

describe('lib/tui and lib/cockpit2 import boundary', () => {
  it('lib/tui and lib/cockpit2 import nothing but orc-state/client, their own modules and pure helpers', () => {
    const [tui, cockpit2] = BOUNDARY_DIRS.map((dir) => sourceFiles(dir));
    expect(tui.length).toBeGreaterThan(3);
    expect(cockpit2.length).toBeGreaterThan(0);
    expect([...tui, ...cockpit2].flatMap((file) => violations(file, readFileSync(file, 'utf8')))).toEqual([]);
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

  it('fails on a lib/cockpit2 import of an adapter, paths or a lib/tui module (negative cases)', () => {
    const file = join(REPO_ROOT, 'lib', 'cockpit2', 'example.ts');
    const source = [
      "import { tmuxBinary } from '../../adapters/tmux.ts';",
      "import { STATE_DIR } from '../paths.ts';",
      "import { Header } from '../tui/Header.tsx';",
      "import { TmuxControlParser } from '../terminalHost.ts';",
      "import { MASTER_TAB } from '../cockpitTabs.ts';",
      "import { TmuxControlClient } from './tmuxControl.ts';",
    ].join('\n');
    expect(violations(file, source)).toEqual([
      'lib/cockpit2/example.ts: adapters/tmux.ts is not orc-state/client',
      'lib/cockpit2/example.ts: lib/paths.ts is not orc-state/client',
      'lib/cockpit2/example.ts: lib/tui/Header.tsx is not orc-state/client',
    ]);
  });

  it('every lib/cockpit2 tui allowlist module is Ink-free, IO-free and closed over the allowlist', () => {
    for (const module of COCKPIT2_TUI_MODULES) {
      const source = readFileSync(module, 'utf8');
      const runtime = importsOf(source).filter((ref) => !ref.typeOnly);
      for (const ref of runtime) {
        const name = relative(REPO_ROOT, module);
        expect(ref.specifier, name).not.toMatch(/^(ink|react)(\/|$)|^(node:)?(fs|child_process)(\/|$)/);
        if (!ref.specifier.startsWith('.')) continue;
        const target = resolve(dirname(module), ref.specifier);
        expect(COCKPIT2_TUI_MODULES.has(target) || target === CLIENT_ENTRY || PURE_HELPERS.has(target), `${name} -> ${ref.specifier}`).toBe(true);
      }
      expect(/from\s+['"](ink|react)['"]|\bimport\s*\(\s*['"](ink|react|node:fs|node:child_process)/.test(source), relative(REPO_ROOT, module)).toBe(false);
    }
  });

  it('lets lib/cockpit2 import the allowlisted tui view models but still forbids Ink components', () => {
    const file = join(REPO_ROOT, 'lib', 'cockpit2', 'example.ts');
    const source = [
      "import { ATTENTION_BADGE } from '../tui/sidebar.ts';",
      "import type { TabBarTab } from '../tui/tabBarModel.ts';",
      "import { Header } from '../tui/Header.tsx';",
    ].join('\n');
    expect(violations(file, source)).toEqual(['lib/cockpit2/example.ts: lib/tui/Header.tsx is not orc-state/client']);
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
