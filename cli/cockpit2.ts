#!/usr/bin/env node
/**
 * cli/cockpit2.ts
 * Usage: orc cockpit2   (preview)
 *        orc cockpit2 explorer --project=<id>
 *
 * The cockpit2 preview (Plan 6): one program draws the whole terminal and shows
 * the active tab (a project's master or an agent) in its slot
 * (lib/cockpit2/app.ts), starting in the current project. This layer resolves
 * everything lib/cockpit2 must not read itself: the tmux binary, the view-state
 * file and the cockpit lock under orc's data home, the cockpit keys and the
 * current project, and it runs the project watcher. Quitting (Ctrl-q, or the
 * prefix then d) never stops a master, a worker or a coordinator.
 *
 * `explorer` runs the read-only task explorer (lib/tui/ExplorerView.ts) for
 * the selected project until Esc or q: what the cockpit's explorer tab runs,
 * in a session on its private tmux server (lib/cockpit2/explorer.ts).
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote, tmuxBinary } from '../adapters/tmux.ts';
import { ProjectWatcher } from '../client.ts';
import { resolveCockpitKeys } from '../lib/cockpitKeys.ts';
import { projectDataHome } from '../lib/dataHome.ts';
import { ACTIVE_PROJECT } from '../lib/paths.ts';
import { runApp } from '../lib/cockpit2/app.ts';
import { tmuxExplorerHost } from '../lib/cockpit2/explorer.ts';
import { fdWriter, openTerminal } from '../lib/cockpit2/terminal.ts';
import { createViewStateStore } from '../lib/cockpit2/viewState.ts';
import { cliError, requireProjectScope } from './shared.ts';

/** Where cockpit2 keeps its files under orc's data home: the single-instance lock (Plan 6 Step 12), the view state and its write lock. */
export function cockpit2Paths(dataHome: string): { lockPath: string; viewStatePath: string; viewStateLockPath: string } {
  const dir = join(dataHome, 'cockpit');
  return { lockPath: join(dir, 'cockpit2.lock'), viewStatePath: join(dir, 'view-state.json'), viewStateLockPath: join(dir, 'view-state.lock') };
}

function runtimeImportPath(relativeTsPath: string, relativeJsPath: string): string {
  return import.meta.url.endsWith('.ts') ? relativeTsPath : relativeJsPath;
}

/** The per-project selection a cockpit started inside a project or a worker inherits; the explorer takes its project from `--project` alone. */
const PROJECT_ENV = ['ORC_PROJECT_ID', 'ORC_STATE_DIR', 'ORC_CONTROL_SOCKET', 'ORC_PROJECT_FLAG'];

/** The shell command the explorer tab's session runs: `orc cockpit2 explorer --project=<id>` with this orc. */
export function explorerCommand(orc: string[], projectId: string): string {
  return `unset ${PROJECT_ENV.join(' ')}; ${[...orc, 'cockpit2', 'explorer', `--project=${projectId}`].map(shellQuote).join(' ')}`;
}

/** The command that runs this orc (from source or compiled). */
const thisOrc = (): string[] => [process.execPath, fileURLToPath(new URL(runtimeImportPath('./orc.ts', './orc.js'), import.meta.url))];

async function explorer(): Promise<void> {
  requireProjectScope();
  if (!ACTIVE_PROJECT) cliError('orc cockpit2 explorer needs a project: --project=<id>');
  // Loaded on demand: the explorer is a TSX view, and the cockpit must not load Ink.
  const { runTaskExplorer } = await (import(runtimeImportPath('../lib/tui/ExplorerView.ts', '../lib/tui/ExplorerView.js')) as Promise<typeof import('../lib/tui/ExplorerView.ts')>);
  process.exit(await runTaskExplorer(ACTIVE_PROJECT.id, new ProjectWatcher()));
}

async function main(): Promise<void> {
  const [action, ...rest] = process.argv.slice(2);
  if (action === 'explorer') {
    if (rest.length > 0) cliError(`orc cockpit2 explorer takes no arguments besides --project=<id> (got ${rest.join(' ')})`);
    return explorer();
  }
  if (action !== undefined) cliError(`unknown action '${action}' (orc cockpit2 --help)`);
  requireProjectScope();
  if (!process.stdin.isTTY || !process.stdout.isTTY) cliError('orc cockpit2 needs a terminal (stdin and stdout must be a TTY)');
  const { keys, problems } = resolveCockpitKeys();
  for (const problem of problems) console.error(`Warning: ${problem}`);
  if (!ACTIVE_PROJECT) cliError('orc cockpit2 needs a registered project; run it inside one');
  const { lockPath, viewStatePath, viewStateLockPath } = cockpit2Paths(projectDataHome());
  const watcher = new ProjectWatcher();
  watcher.start();
  const terminal = openTerminal({ input: process.stdin, output: process.stdout, write: fdWriter(process.stdout.fd) });
  try {
    const app = runApp({
      terminal,
      tmuxBinary: tmuxBinary(),
      lockPath,
      store: createViewStateStore({ path: viewStatePath, lockPath: viewStateLockPath }),
      projects: watcher,
      projectId: ACTIVE_PROJECT.id,
      keys,
      explorer: tmuxExplorerHost({ tmuxBinary: tmuxBinary(), command: (projectId) => explorerCommand(thisOrc(), projectId) }),
    });
    await app.done;
    const saveError = app.saveError();
    if (saveError) console.error(`Warning: the cockpit's view state was not saved: ${saveError}`);
  } catch (error) {
    // Back on the main screen first, or the error is printed on the alternate one and lost.
    terminal.restore();
    cliError(error);
  }
  await watcher.stop();
  process.exit(0);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch(cliError);
}
