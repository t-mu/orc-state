#!/usr/bin/env node
/**
 * cli/memory-wake-up.ts
 * Usage: orc memory-wake-up [--wing=X] [--budget=N]
 *
 * Exits 0 with informative message when memory.db doesn't exist.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from '../lib/paths.ts';
import { closeMemoryDb, memoryWakeUp } from '../lib/memoryStore.ts';
import { flag, intFlag } from '../lib/args.ts';

export function printMemoryWakeUp(stateDir: string, opts: { wing?: string | null; budget?: number } = {}): number {
  const dbPath = join(stateDir, 'memory.db');
  if (!existsSync(dbPath)) {
    console.log('Memory store not initialized (memory.db not found).');
    return 0;
  }
  const text = memoryWakeUp(stateDir, {
    ...(opts.wing ? { wing: opts.wing } : {}),
    tokenBudget: opts.budget ?? 800,
  });
  if (text) {
    console.log(text);
  }
  closeMemoryDb();
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const wing = flag('wing');
  const budget = intFlag('budget', 800);
  process.exit(printMemoryWakeUp(STATE_DIR, { wing, budget }));
}
