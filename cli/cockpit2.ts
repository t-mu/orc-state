#!/usr/bin/env node
/**
 * cli/cockpit2.ts
 * Usage: orc cockpit2   (preview)
 *
 * The cockpit2 preview (Plan 6): one program draws the whole terminal and shows
 * the current project's master in its slot (lib/cockpit2/app.ts). This layer
 * resolves everything lib/cockpit2 must not read itself: the tmux binary, orc's
 * data home, the cockpit lock, the cockpit keys and the master's tmux target.
 * Quitting (Ctrl-q, or the prefix then d) never stops the master, a worker or
 * the coordinator.
 */
import { join } from 'node:path';
import { tmuxBinary } from '../adapters/tmux.ts';
import { resolveCockpitKeys } from '../lib/cockpitKeys.ts';
import { projectDataHome } from '../lib/dataHome.ts';
import { ACTIVE_PROJECT, STATE_DIR } from '../lib/paths.ts';
import { resolveMasterTarget, runApp } from '../lib/cockpit2/app.ts';
import { fdWriter, openTerminal } from '../lib/cockpit2/terminal.ts';
import { cliError, requireProjectScope } from './shared.ts';

/** Where cockpit2 keeps its files under orc's data home: the single-instance lock (Plan 6 Step 12) and, later, the view state. */
export function cockpit2Paths(dataHome: string): { dataHome: string; lockPath: string } {
  return { dataHome, lockPath: join(dataHome, 'cockpit', 'cockpit2.lock') };
}

async function main(): Promise<void> {
  requireProjectScope();
  if (!process.stdin.isTTY || !process.stdout.isTTY) cliError('orc cockpit2 needs a terminal (stdin and stdout must be a TTY)');
  const { keys, problems } = resolveCockpitKeys();
  for (const problem of problems) console.error(`Warning: ${problem}`);
  const target = await resolveMasterTarget(STATE_DIR);
  const terminal = openTerminal({ input: process.stdin, output: process.stdout, write: fdWriter(process.stdout.fd) });
  try {
    const app = runApp({
      terminal,
      tmuxBinary: tmuxBinary(),
      ...cockpit2Paths(projectDataHome()),
      projectName: ACTIVE_PROJECT?.name ?? 'orc',
      target,
      keys,
    });
    await app.done;
  } catch (error) {
    // Back on the main screen first, or the error is printed on the alternate one and lost.
    terminal.restore();
    cliError(error);
  }
  process.exit(0);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch(cliError);
}
