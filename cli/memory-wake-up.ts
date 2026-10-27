#!/usr/bin/env node
/**
 * cli/memory-wake-up.ts
 * Usage: orc memory-wake-up [--wing=X] [--budget=N]
 *
 * Exits 0 with informative message when memory.db doesn't exist. In a
 * registered project the running coordinator serves the memories, so a
 * sandboxed worker without write access can read them.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from '../lib/paths.ts';
import { closeMemoryDb, getMemoryDb, memoryWakeUp } from '../lib/memoryStore.ts';
import { flag, intFlag } from '../lib/args.ts';
import { readProjectState } from '../lib/projectReads.ts';
import { cliError } from './shared.ts';

type WakeUpOptions = { wing?: string | null; budget?: number };

export function readMemoryWakeUp(stateDir: string, opts: WakeUpOptions = {}): { initialized: boolean; text: string } {
  if (!existsSync(join(stateDir, 'memory.db'))) return { initialized: false, text: '' };
  // Open first: memoryWakeUp reports an unreadable store as no memories.
  getMemoryDb(stateDir);
  try {
    return {
      initialized: true,
      text: memoryWakeUp(stateDir, {
        ...(opts.wing ? { wing: opts.wing } : {}),
        tokenBudget: opts.budget ?? 800,
      }),
    };
  } finally {
    closeMemoryDb(stateDir);
  }
}

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
  return printWakeUp(readMemoryWakeUp(stateDir, opts));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const opts = { wing: flag('wing'), budget: intFlag('budget', 800) };
  try {
    process.exit(printWakeUp(await readProjectState(
      (client) => client.memoryWakeUp(opts),
      () => readMemoryWakeUp(STATE_DIR, opts),
    )));
  } catch (error) {
    cliError(error);
  }
}
