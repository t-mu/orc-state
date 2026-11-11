#!/usr/bin/env node
/**
 * cli/cockpit2.ts
 * Usage: orc cockpit2   (preview)
 *
 * The cockpit2 preview (Plan 6): one program draws the whole terminal and shows
 * the active tab (a project's master or an agent) in its slot
 * (lib/cockpit2/app.ts), starting in the current project. This layer resolves
 * everything lib/cockpit2 must not read itself: the tmux binary, the view-state
 * file and the cockpit lock under orc's data home, the cockpit keys and the
 * current project, and it runs the project watcher. Quitting (Ctrl-q, or the
 * prefix then d) never stops a master, a worker or a coordinator.
 */
import { join } from 'node:path';
import { tmuxBinary } from '../adapters/tmux.ts';
import { ProjectWatcher } from '../client.ts';
import { resolveCockpitKeys } from '../lib/cockpitKeys.ts';
import { projectDataHome } from '../lib/dataHome.ts';
import { ACTIVE_PROJECT } from '../lib/paths.ts';
import { runApp } from '../lib/cockpit2/app.ts';
import { fdWriter, openTerminal } from '../lib/cockpit2/terminal.ts';
import { createViewStateStore } from '../lib/cockpit2/viewState.ts';
import { cliError, requireProjectScope } from './shared.ts';

/** Where cockpit2 keeps its files under orc's data home: the single-instance lock (Plan 6 Step 12), the view state and its write lock. */
export function cockpit2Paths(dataHome: string): { lockPath: string; viewStatePath: string; viewStateLockPath: string } {
  const dir = join(dataHome, 'cockpit');
  return { lockPath: join(dir, 'cockpit2.lock'), viewStatePath: join(dir, 'view-state.json'), viewStateLockPath: join(dir, 'view-state.lock') };
}

async function main(): Promise<void> {
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
