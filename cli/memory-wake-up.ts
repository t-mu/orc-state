#!/usr/bin/env node
/**
 * cli/memory-wake-up.ts
 * Usage: orc memory-wake-up [--wing=X] [--budget=N]
 *
 * Exits 0 with informative message when memory.db doesn't exist, and 1 when
 * an existing store cannot be read. In a registered project the running
 * coordinator serves the memories, so a sandboxed worker without write
 * access can read them.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from '../lib/paths.ts';
import { closeMemoryDb } from '../lib/memoryStore.ts';
import { flag, intFlag } from '../lib/args.ts';
import { DEFAULT_WAKE_UP_BUDGET, isWakeUpBudget, readMemoryWakeUp, readViaCoordinator } from '../lib/projectReads.ts';
import { cliError } from './shared.ts';

type WakeUpOptions = { wing?: string | null; budget?: number };

function printWakeUp({ initialized, text }: { initialized: boolean; text: string }): number {
  if (!initialized) {
    console.log('Memory store not initialized (memory.db not found).');
    return 0;
  }
  if (text) {
    console.log(text);
  }
  return 0;
}

export function printMemoryWakeUp(stateDir: string, opts: WakeUpOptions = {}): number {
  try {
    return printWakeUp(readMemoryWakeUp(stateDir, opts));
  } finally {
    closeMemoryDb(stateDir);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const opts = { wing: flag('wing'), budget: intFlag('budget', DEFAULT_WAKE_UP_BUDGET) };
  try {
    if (!isWakeUpBudget(opts.budget)) throw new Error('--budget must be a positive integer');
    process.exit(printWakeUp(await readViaCoordinator(
      (client) => client.memoryWakeUp(opts),
      () => readMemoryWakeUp(STATE_DIR, opts),
    )));
  } catch (error) {
    cliError(error);
  } finally {
    closeMemoryDb(STATE_DIR);
  }
}
